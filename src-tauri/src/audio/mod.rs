use crate::input::adapter::BpmRuntimeSnapshot;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FFT_WINDOW: usize = 512;
const FFT_LOW_BIN_START: usize = 2;
const FFT_LOW_BIN_END: usize = 28;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpmConfig {
    pub enabled: bool,
    pub sensitivity: f32,
    pub gate: f32,
    pub smoothing: f32,
    pub attack: f32,
    pub decay: f32,
    pub manual_bpm: f32,
}

impl Default for BpmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sensitivity: 1.0,
            gate: 0.28,
            smoothing: 0.82,
            attack: 0.85,
            decay: 0.75,
            manual_bpm: 120.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpmState {
    pub bpm: f32,
    pub beat: f32,
    pub level: f32,
    pub phase: f32,
    pub running: bool,
    pub selected_device_id: Option<String>,
    pub selected_device_name: Option<String>,
    pub last_beat_ms: u64,
}

impl Default for BpmState {
    fn default() -> Self {
        Self {
            bpm: 120.0,
            beat: 0.0,
            level: 0.0,
            phase: 0.0,
            running: false,
            selected_device_id: None,
            selected_device_name: None,
            last_beat_ms: 0,
        }
    }
}

enum WorkerCommand {
    ListDevices {
        reply: mpsc::Sender<Vec<AudioInputDevice>>,
    },
    SetDevice {
        device_id: String,
        reply: mpsc::Sender<Result<BpmState, String>>,
    },
    SetConfig {
        config: BpmConfig,
        reply: mpsc::Sender<Result<BpmState, String>>,
    },
    GetState {
        reply: mpsc::Sender<BpmState>,
    },
    TapTempo {
        reply: mpsc::Sender<BpmState>,
    },
    RuntimeSnapshot {
        reply: mpsc::Sender<BpmRuntimeSnapshot>,
    },
}

pub struct BpmEngine {
    tx: parking_lot::Mutex<mpsc::Sender<WorkerCommand>>,
}

impl BpmEngine {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<WorkerCommand>();
        std::thread::spawn(move || {
            let mut worker = WorkerState::new();
            loop {
                match rx.recv_timeout(Duration::from_millis(40)) {
                    Ok(command) => worker.handle_command(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => worker.tick(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        Self {
            tx: parking_lot::Mutex::new(tx),
        }
    }

    pub fn list_input_devices(&self) -> Vec<AudioInputDevice> {
        self.request(|reply| WorkerCommand::ListDevices { reply })
            .unwrap_or_default()
    }

    pub fn set_audio_input_device(&self, device_id: &str) -> Result<BpmState, String> {
        self.request(|reply| WorkerCommand::SetDevice {
            device_id: device_id.to_string(),
            reply,
        })?
    }

    pub fn set_bpm_config(&self, config: BpmConfig) -> Result<BpmState, String> {
        self.request(|reply| WorkerCommand::SetConfig { config, reply })?
    }

    pub fn get_bpm_state(&self) -> BpmState {
        self.request(|reply| WorkerCommand::GetState { reply })
            .unwrap_or_default()
    }

    pub fn tap_tempo(&self) -> BpmState {
        self.request(|reply| WorkerCommand::TapTempo { reply })
            .unwrap_or_default()
    }

    pub fn runtime_snapshot(&self) -> BpmRuntimeSnapshot {
        self.request(|reply| WorkerCommand::RuntimeSnapshot { reply })
            .unwrap_or_default()
    }

    fn request<T>(
        &self,
        build: impl FnOnce(mpsc::Sender<T>) -> WorkerCommand,
    ) -> Result<T, String> {
        let (reply_tx, reply_rx) = mpsc::channel::<T>();
        self.tx
            .lock()
            .send(build(reply_tx))
            .map_err(|_| "Audio worker channel is closed".to_string())?;
        reply_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "Audio worker did not respond".to_string())
    }
}

struct WorkerState {
    host: cpal::Host,
    stream: Option<cpal::Stream>,
    sample_buffer: std::sync::Arc<parking_lot::Mutex<Vec<f32>>>,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    fft_window: [f32; FFT_WINDOW],
    fft_buffer: [Complex<f32>; FFT_WINDOW],
    config: BpmConfig,
    state: BpmState,
    beat_decay: f32,
    beat_history: Vec<Instant>,
    tap_history: Vec<Instant>,
    last_beat_instant: Option<Instant>,
    last_tick: Instant,
}

impl WorkerState {
    fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_WINDOW);
        let mut fft_window = [0.0f32; FFT_WINDOW];
        for (idx, w) in fft_window.iter_mut().enumerate() {
            *w = 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * idx as f32) / FFT_WINDOW as f32).cos();
        }

        Self {
            host: cpal::default_host(),
            stream: None,
            sample_buffer: std::sync::Arc::new(parking_lot::Mutex::new(Vec::with_capacity(8192))),
            fft,
            fft_window,
            fft_buffer: [Complex::new(0.0, 0.0); FFT_WINDOW],
            config: BpmConfig::default(),
            state: BpmState::default(),
            beat_decay: 0.0,
            beat_history: Vec::new(),
            tap_history: Vec::new(),
            last_beat_instant: None,
            last_tick: Instant::now(),
        }
    }

    fn handle_command(&mut self, command: WorkerCommand) {
        match command {
            WorkerCommand::ListDevices { reply } => {
                let _ = reply.send(self.list_input_devices());
            }
            WorkerCommand::SetDevice { device_id, reply } => {
                let _ = reply.send(self.set_audio_input_device(&device_id));
            }
            WorkerCommand::SetConfig { config, reply } => {
                let _ = reply.send(self.set_bpm_config(config));
            }
            WorkerCommand::GetState { reply } => {
                let _ = reply.send(self.get_bpm_state());
            }
            WorkerCommand::TapTempo { reply } => {
                let _ = reply.send(self.tap_tempo());
            }
            WorkerCommand::RuntimeSnapshot { reply } => {
                let _ = reply.send(self.runtime_snapshot());
            }
        }
    }

    fn list_input_devices(&self) -> Vec<AudioInputDevice> {
        let default_name = self
            .host
            .default_input_device()
            .and_then(|device| device.name().ok());

        let mut out = Vec::new();
        let Ok(devices) = self.host.input_devices() else {
            return out;
        };

        for (index, device) in devices.enumerate() {
            let name = device.name().unwrap_or_else(|_| format!("Input {}", index + 1));
            let cfg = device.default_input_config().ok();
            out.push(AudioInputDevice {
                id: device_id(index, &name),
                name: name.clone(),
                channels: cfg.as_ref().map(|c| c.channels()).unwrap_or(0),
                sample_rate: cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
                is_default: default_name.as_deref() == Some(name.as_str()),
            });
        }
        out
    }

    fn set_audio_input_device(&mut self, device_id: &str) -> Result<BpmState, String> {
        let (device, device_name) = self.resolve_input_device(device_id)?;
        self.start_stream(device, device_id.to_string(), device_name)?;
        Ok(self.get_bpm_state())
    }

    fn set_bpm_config(&mut self, config: BpmConfig) -> Result<BpmState, String> {
        self.config = normalize_bpm_config(config);

        if !self.config.enabled {
            self.stop_stream();
            self.state.running = false;
            self.beat_decay = 0.0;
            self.state.beat = 0.0;
            self.state.level = 0.0;
            return Ok(self.get_bpm_state());
        }

        if self.stream.is_none() {
            if let Some(device_id) = self.state.selected_device_id.clone() {
                let (device, device_name) = self.resolve_input_device(&device_id)?;
                self.start_stream(device, device_id, device_name)?;
            } else if let Some(default) = self.list_input_devices().into_iter().find(|d| d.is_default) {
                let (device, device_name) = self.resolve_input_device(&default.id)?;
                self.start_stream(device, default.id, device_name)?;
            }
        }

        Ok(self.get_bpm_state())
    }

    fn get_bpm_state(&mut self) -> BpmState {
        self.tick();
        self.state.clone()
    }

    fn tap_tempo(&mut self) -> BpmState {
        let now = Instant::now();
        self.tap_history.push(now);
        if self.tap_history.len() > 6 {
            let remove = self.tap_history.len() - 6;
            self.tap_history.drain(0..remove);
        }

        if self.tap_history.len() >= 2 {
            let mut intervals = Vec::new();
            for pair in self.tap_history.windows(2) {
                let dt = pair[1].duration_since(pair[0]).as_secs_f32();
                if dt > 0.2 && dt < 2.5 {
                    intervals.push(dt);
                }
            }
            if !intervals.is_empty() {
                let avg = intervals.iter().sum::<f32>() / intervals.len() as f32;
                let bpm = (60.0 / avg).clamp(40.0, 220.0);
                self.config.manual_bpm = bpm;
                self.state.bpm = bpm;
                self.last_beat_instant = Some(now);
                self.state.last_beat_ms = unix_ms_now();
                self.beat_decay = 1.0;
            }
        }
        self.get_bpm_state()
    }

    fn runtime_snapshot(&mut self) -> BpmRuntimeSnapshot {
        let state = self.get_bpm_state();
        BpmRuntimeSnapshot {
            bpm: state.bpm.max(1.0),
            beat: state.beat.clamp(0.0, 1.0),
            level: state.level.clamp(0.0, 1.0),
            phase: state.phase.fract(),
        }
    }

    fn resolve_input_device(&self, wanted_id: &str) -> Result<(cpal::Device, String), String> {
        let devices = self
            .host
            .input_devices()
            .map_err(|err| format!("Failed to enumerate input devices: {}", err))?;

        for (index, device) in devices.enumerate() {
            let name = device.name().unwrap_or_else(|_| format!("Input {}", index + 1));
            let id = device_id(index, &name);
            if id == wanted_id {
                return Ok((device, name));
            }
        }

        Err(format!("Audio input device not found: {}", wanted_id))
    }

    fn start_stream(
        &mut self,
        device: cpal::Device,
        device_id: String,
        device_name: String,
    ) -> Result<(), String> {
        self.stop_stream();

        let default_cfg = device
            .default_input_config()
            .map_err(|err| format!("Failed to read device config: {}", err))?;
        let channels = default_cfg.channels();
        let stream_cfg: cpal::StreamConfig = default_cfg.config();
        let sample_buffer = self.sample_buffer.clone();

        let err_fn = |err| {
            log::warn!("Audio input stream error: {}", err);
        };

        let stream = match default_cfg.sample_format() {
            cpal::SampleFormat::F32 => device
                .build_input_stream(
                    &stream_cfg,
                    move |data: &[f32], _| push_samples(data, channels, &sample_buffer, |v| v),
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Failed to build input stream: {}", err))?,
            cpal::SampleFormat::I16 => device
                .build_input_stream(
                    &stream_cfg,
                    move |data: &[i16], _| {
                        push_samples(data, channels, &sample_buffer, |v| v as f32 / i16::MAX as f32)
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Failed to build input stream: {}", err))?,
            cpal::SampleFormat::U16 => device
                .build_input_stream(
                    &stream_cfg,
                    move |data: &[u16], _| {
                        push_samples(data, channels, &sample_buffer, |v| {
                            (v as f32 / u16::MAX as f32) * 2.0 - 1.0
                        })
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Failed to build input stream: {}", err))?,
            other => {
                return Err(format!("Unsupported input sample format: {:?}", other));
            }
        };

        stream
            .play()
            .map_err(|err| format!("Failed to start audio input stream: {}", err))?;

        self.stream = Some(stream);
        self.state.selected_device_id = Some(device_id);
        self.state.selected_device_name = Some(device_name);
        self.state.running = true;
        self.sample_buffer.lock().clear();
        Ok(())
    }

    fn stop_stream(&mut self) {
        if self.stream.take().is_some() {
            log::info!("Audio input stream stopped");
        }
    }

    fn tick(&mut self) {
        let now = Instant::now();
        let dt = now
            .saturating_duration_since(self.last_tick)
            .as_secs_f32()
            .clamp(0.0, 0.25);
        self.last_tick = now;

        let mut fft_input = [0.0f32; FFT_WINDOW];
        let mut has_fft_input = false;
        let buffer = self.sample_buffer.lock();
        let mut rms = 0.0f32;
        if !buffer.is_empty() {
            let mut sum = 0.0;
            for sample in buffer.iter() {
                sum += sample * sample;
            }
            rms = (sum / buffer.len() as f32).sqrt();
        }
        if buffer.len() >= FFT_WINDOW {
            let tail = &buffer[buffer.len() - FFT_WINDOW..];
            fft_input.copy_from_slice(tail);
            has_fft_input = true;
        }
        drop(buffer);
        let fft_energy = if has_fft_input {
            self.low_band_energy(&fft_input)
        } else {
            0.0
        };

        let raw_level = (rms * 0.65 + fft_energy * 0.35) * self.config.sensitivity.clamp(0.1, 5.0);
        let smooth = self.config.smoothing.clamp(0.0, 0.98);
        self.state.level = (self.state.level * smooth + raw_level * (1.0 - smooth)).clamp(0.0, 1.5);

        let mut beat_triggered = false;
        let min_interval = Duration::from_millis(150);
        let can_trigger = self
            .last_beat_instant
            .map(|last| now.saturating_duration_since(last) > min_interval)
            .unwrap_or(true);
        if self.state.level > self.config.gate.clamp(0.01, 1.0) && can_trigger {
            beat_triggered = true;
            self.last_beat_instant = Some(now);
            self.state.last_beat_ms = unix_ms_now();
            self.beat_decay = 1.0;
            self.beat_history.push(now);
            if self.beat_history.len() > 16 {
                let remove = self.beat_history.len() - 16;
                self.beat_history.drain(0..remove);
            }
        }

        if beat_triggered && self.config.manual_bpm <= 0.0 {
            let mut intervals = Vec::new();
            for pair in self.beat_history.windows(2) {
                let delta = pair[1].duration_since(pair[0]).as_secs_f32();
                if delta > 0.2 && delta < 2.5 {
                    intervals.push(delta);
                }
            }
            if !intervals.is_empty() {
                let avg = intervals.iter().sum::<f32>() / intervals.len() as f32;
                self.state.bpm = (60.0 / avg).clamp(40.0, 220.0);
            }
        } else if self.config.manual_bpm > 0.0 {
            self.state.bpm = self.config.manual_bpm.clamp(40.0, 220.0);
        }

        if self.state.bpm <= 0.1 {
            self.state.bpm = 120.0;
        }

        let beat_interval = 60.0 / self.state.bpm.max(1.0);
        self.state.phase = if let Some(last) = self.last_beat_instant {
            (now.saturating_duration_since(last).as_secs_f32() / beat_interval).fract()
        } else {
            0.0
        };

        let attack = self.config.attack.clamp(0.05, 1.0);
        let decay = self.config.decay.clamp(0.05, 0.99);
        if beat_triggered {
            self.state.beat = (self.state.beat * (1.0 - attack) + attack).clamp(0.0, 1.0);
            self.beat_decay = 1.0;
        } else {
            self.beat_decay *= decay.powf((dt * 60.0).max(1.0));
            self.state.beat = self.beat_decay.clamp(0.0, 1.0);
        }

        if !self.config.enabled {
            self.state.running = false;
            self.state.beat = 0.0;
            self.state.level = 0.0;
        } else if self.stream.is_none() {
            self.state.running = false;
        }
    }

    fn low_band_energy(&mut self, input: &[f32; FFT_WINDOW]) -> f32 {
        for idx in 0..FFT_WINDOW {
            self.fft_buffer[idx].re = input[idx] * self.fft_window[idx];
            self.fft_buffer[idx].im = 0.0;
        }

        self.fft.process(&mut self.fft_buffer);

        let mut low_energy = 0.0f32;
        let mut total_energy = 0.0f32;
        for (idx, bin) in self.fft_buffer.iter().enumerate().take(FFT_WINDOW / 2) {
            let mag = bin.norm_sqr();
            total_energy += mag;
            if idx >= FFT_LOW_BIN_START && idx <= FFT_LOW_BIN_END {
                low_energy += mag;
            }
        }

        if total_energy <= f32::EPSILON {
            0.0
        } else {
            (low_energy / total_energy).clamp(0.0, 1.0)
        }
    }
}

fn device_id(index: usize, name: &str) -> String {
    let normalized = name
        .to_ascii_lowercase()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "-");
    format!("{}-{}", index, normalized)
}

fn normalize_bpm_config(mut config: BpmConfig) -> BpmConfig {
    config.sensitivity = config.sensitivity.clamp(0.1, 5.0);
    config.gate = config.gate.clamp(0.01, 1.0);
    config.smoothing = config.smoothing.clamp(0.0, 0.98);
    config.attack = config.attack.clamp(0.05, 1.0);
    config.decay = config.decay.clamp(0.05, 0.99);
    if config.manual_bpm.is_finite() {
        config.manual_bpm = config.manual_bpm.clamp(0.0, 220.0);
    } else {
        config.manual_bpm = 120.0;
    }
    config
}

fn push_samples<T: Copy>(
    data: &[T],
    channels: u16,
    sample_buffer: &std::sync::Arc<parking_lot::Mutex<Vec<f32>>>,
    convert: impl Fn(T) -> f32,
) {
    let channels = channels.max(1) as usize;
    let mut mono = Vec::with_capacity(data.len() / channels);

    for frame in data.chunks(channels) {
        let mut sum = 0.0f32;
        for sample in frame {
            sum += convert(*sample);
        }
        mono.push(sum / channels as f32);
    }

    let mut buf = sample_buffer.lock();
    buf.extend(mono);
    const MAX_SAMPLES: usize = 8192;
    if buf.len() > MAX_SAMPLES {
        let drop_count = buf.len() - MAX_SAMPLES;
        buf.drain(0..drop_count);
    }
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}
