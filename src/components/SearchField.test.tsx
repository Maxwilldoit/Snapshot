import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchField } from "./SearchField";

/** 工具栏搜索收起后仍然要能一键找到：Ctrl/Cmd+F 聚焦，带筛选词时保持展开 */
describe("SearchField", () => {
  it("Ctrl+F 和 Cmd+F 聚焦搜索框，普通 f 不拦截", () => {
    render(<SearchField value="" onChange={() => {}} label="搜索截图" />);
    const input = screen.getByRole("textbox", { name: "搜索截图" });

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(input);

    input.blur();
    fireEvent.keyDown(window, { key: "f" });
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: "F", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("有筛选词时挂上展开标记，清空后收起", () => {
    const { container, rerender } = render(<SearchField value="浏览器" onChange={() => {}} label="搜索截图" />);
    expect(container.querySelector(".mw-search")?.classList.contains("is-active")).toBe(true);
    expect(screen.getByRole("button", { name: "清除搜索" })).toBeTruthy();

    rerender(<SearchField value="" onChange={() => {}} label="搜索截图" />);
    expect(container.querySelector(".mw-search")?.classList.contains("is-active")).toBe(false);
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  });

  it("外部 inputRef 仍然拿得到输入框", () => {
    let node: HTMLInputElement | null = null;
    render(<SearchField value="" onChange={() => {}} label="搜索截图" inputRef={(element) => { node = element; }} />);
    expect(node).toBe(screen.getByRole("textbox", { name: "搜索截图" }));
  });
});
