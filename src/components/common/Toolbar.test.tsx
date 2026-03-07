import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock package.json import
vi.mock("../../../package.json", () => ({
  default: { version: "0.0.0-test" },
}));

// Mock child components that have their own complex imports
vi.mock("../output/OutputConfigPanel", () => ({
  default: () => <div data-testid="output-config-panel" />,
}));

vi.mock("./SettingsModal", () => ({
  default: ({ open }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="settings-modal" /> : null,
}));

import Toolbar from "./Toolbar";

describe("Toolbar", () => {
  it("renders without crashing", () => {
    render(<Toolbar />);
  });

  it("has a New button", () => {
    render(<Toolbar />);
    expect(screen.getByText("New")).toBeDefined();
  });

  it("has an Open button", () => {
    render(<Toolbar />);
    expect(screen.getByText("Open")).toBeDefined();
  });

  it("has a Save button", () => {
    render(<Toolbar />);
    expect(screen.getByTitle("Save Project (Cmd+S)")).toBeDefined();
  });

  it("has Save As button", () => {
    render(<Toolbar />);
    expect(screen.getByText("Save As")).toBeDefined();
  });

  it("has Undo and Redo buttons", () => {
    render(<Toolbar />);
    expect(screen.getByText("Undo")).toBeDefined();
    expect(screen.getByText("Redo")).toBeDefined();
  });

  it("has a projector toggle button", () => {
    render(<Toolbar />);
    expect(screen.getByText("Open Projector")).toBeDefined();
  });

  it("displays FlexMap title", () => {
    render(<Toolbar />);
    expect(screen.getByText("FlexMap")).toBeDefined();
  });

  it("displays version from package.json", () => {
    render(<Toolbar />);
    expect(screen.getByText(/v0\.0\.0-test/)).toBeDefined();
  });
});
