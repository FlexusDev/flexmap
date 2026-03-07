import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Slider from "./Slider";

const defaultProps = {
  label: "Opacity",
  value: 0.75,
  min: 0,
  max: 1,
  step: 0.01,
  decimals: 2,
  onChange: vi.fn(),
};

describe("Slider", () => {
  it("renders label and value", () => {
    render(<Slider {...defaultProps} />);
    expect(screen.getByText("Opacity")).toBeDefined();
    expect(screen.getByText("0.75")).toBeDefined();
  });

  it('shows "Mixed" when mixed prop is true', () => {
    render(<Slider {...defaultProps} mixed />);
    expect(screen.getByText("Mixed")).toBeDefined();
    // Should not show numeric value
    expect(screen.queryByText("0.75")).toBeNull();
  });

  it("enters edit mode on value click", () => {
    render(<Slider {...defaultProps} />);
    const valueDisplay = screen.getByTestId("slider-value");
    fireEvent.click(valueDisplay);
    // Should now have an input with the value
    const input = screen.getByDisplayValue("0.75");
    expect(input).toBeDefined();
    expect(input.tagName).toBe("INPUT");
  });

  it("commits edit on Enter", () => {
    const onChange = vi.fn();
    render(<Slider {...defaultProps} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("slider-value"));
    const input = screen.getByDisplayValue("0.75");
    fireEvent.change(input, { target: { value: "0.50" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it("cancels edit on Escape", () => {
    const onChange = vi.fn();
    render(<Slider {...defaultProps} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("slider-value"));
    const input = screen.getByDisplayValue("0.75");
    fireEvent.change(input, { target: { value: "0.99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // onChange should not have been called with 0.99
    expect(onChange).not.toHaveBeenCalledWith(0.99);
    // Value display should be back
    expect(screen.getByText("0.75")).toBeDefined();
  });

  it("shows reset button when onReset is provided", () => {
    const onReset = vi.fn();
    render(<Slider {...defaultProps} onReset={onReset} />);
    const resetBtn = screen.getByTitle("Reset");
    expect(resetBtn).toBeDefined();
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("clamps values to min/max on edit commit", () => {
    const onChange = vi.fn();
    render(<Slider {...defaultProps} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("slider-value"));
    const input = screen.getByDisplayValue("0.75");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(1);
  });
});
