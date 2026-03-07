import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import NumericField from "./NumericField";

const defaultProps = {
  label: "X",
  value: 45,
  min: 0,
  max: 360,
  step: 1,
  decimals: 0,
  onChange: vi.fn(),
};

describe("NumericField", () => {
  it("renders label and value", () => {
    render(<NumericField {...defaultProps} />);
    expect(screen.getByText("X")).toBeDefined();
    expect(screen.getByText("45")).toBeDefined();
  });

  it("enters edit mode on double-click", () => {
    render(<NumericField {...defaultProps} />);
    const valueDisplay = screen.getByTestId("numeric-value");
    fireEvent.doubleClick(valueDisplay);
    const input = screen.getByDisplayValue("45");
    expect(input).toBeDefined();
    expect(input.tagName).toBe("INPUT");
  });

  it("shows suffix appended to value", () => {
    render(<NumericField {...defaultProps} suffix="°" />);
    expect(screen.getByText("45°")).toBeDefined();
  });

  it('shows "Mixed" when mixed prop is true', () => {
    render(<NumericField {...defaultProps} mixed />);
    expect(screen.getByText("Mixed")).toBeDefined();
    expect(screen.queryByText("45")).toBeNull();
  });

  it("commits edit on Enter", () => {
    const onChange = vi.fn();
    render(<NumericField {...defaultProps} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByTestId("numeric-value"));
    const input = screen.getByDisplayValue("45");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(90);
  });

  it("cancels edit on Escape", () => {
    const onChange = vi.fn();
    render(<NumericField {...defaultProps} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByTestId("numeric-value"));
    const input = screen.getByDisplayValue("45");
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalledWith(200);
    expect(screen.getByText("45")).toBeDefined();
  });

  it("clamps values to min/max on edit commit", () => {
    const onChange = vi.fn();
    render(<NumericField {...defaultProps} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByTestId("numeric-value"));
    const input = screen.getByDisplayValue("45");
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(360);
  });
});
