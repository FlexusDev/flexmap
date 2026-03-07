import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { useAppStore } from "../../store/useAppStore";
import ToastContainer from "./ToastContainer";

describe("ToastContainer", () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
  });

  it("renders without crashing when there are no toasts", () => {
    const { container } = render(<ToastContainer />);
    // Should return null / render nothing when no toasts
    expect(container.innerHTML).toBe("");
  });

  it("renders toasts when present", () => {
    act(() => {
      useAppStore.getState().addToast("Hello world", "info");
    });

    render(<ToastContainer />);
    expect(screen.getByText("Hello world")).toBeDefined();
  });

  it("renders multiple toasts", () => {
    act(() => {
      useAppStore.getState().addToast("First toast", "info");
      useAppStore.getState().addToast("Second toast", "error");
    });

    render(<ToastContainer />);
    expect(screen.getByText("First toast")).toBeDefined();
    expect(screen.getByText("Second toast")).toBeDefined();
  });

  it("renders dismiss buttons for each toast", () => {
    act(() => {
      useAppStore.getState().addToast("Dismissable", "warning");
    });

    render(<ToastContainer />);
    // Each toast has a dismiss button
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });
});
