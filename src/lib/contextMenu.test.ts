import { afterEach, describe, expect, it } from "vitest";
import { allowsNativeContextMenu, suppressNativeContextMenu } from "./contextMenu";

const fire = (target: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("native context menu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("is suppressed on images and plain UI but kept in text fields and on selected text", () => {
    const stop = suppressNativeContextMenu();
    document.body.innerHTML = `
      <img alt="" src="data:," />
      <button type="button">Copy</button>
      <input type="text" value="hello" />
      <input type="checkbox" />
      <textarea>notes</textarea>
      <div contenteditable="true"><span>rich</span></div>
      <p>Selectable words</p>`;
    const [img, button, text, checkbox, area, rich, paragraph] = [
      "img", "button", "input[type=text]", "input[type=checkbox]", "textarea", "[contenteditable] span", "p",
    ].map((selector) => document.querySelector(selector)!);

    expect(fire(img)).toBe(true);
    expect(fire(button)).toBe(true);
    expect(fire(checkbox)).toBe(true);
    expect(fire(text)).toBe(false);
    expect(fire(area)).toBe(false);
    expect(fire(rich)).toBe(false);

    expect(fire(paragraph)).toBe(true);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.addRange(range);
    expect(fire(paragraph)).toBe(false);
    stop();
    window.getSelection()!.removeAllRanges();
    expect(fire(img)).toBe(false);
  });

  it("does not keep the native menu without a target", () => {
    expect(allowsNativeContextMenu(null, null)).toBe(false);
  });
});
