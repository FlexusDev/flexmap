import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlendModePicker } from "./BlendModePicker";

describe("BlendModePicker", () => {
  it("shows current blend mode label", () => {
    render(
      <BlendModePicker value="multiply" onChange={vi.fn()} />
    );
    expect(screen.getByText("Multiply")).toBeDefined();
  });

  it('shows "Mixed" when mixed prop is true', () => {
    render(
      <BlendModePicker value="normal" mixed onChange={vi.fn()} />
    );
    expect(screen.getByText("Mixed")).toBeDefined();
  });

  it("opens popover on click and selects mode", () => {
    const onChange = vi.fn();
    render(
      <BlendModePicker value="normal" onChange={onChange} />
    );

    // Click the trigger button to open popover
    fireEvent.click(screen.getByText("Normal"));

    // The popover should now show all blend mode groups
    expect(screen.getByText("Screen")).toBeDefined();
    expect(screen.getByText("Overlay")).toBeDefined();

    // Click a mode tile
    fireEvent.click(screen.getByText("Screen"));
    expect(onChange).toHaveBeenCalledWith("screen");
  });
});
