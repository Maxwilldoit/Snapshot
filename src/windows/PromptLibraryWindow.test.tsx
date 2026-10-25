import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { invokeArgs, setupTauriMock, type IPCHandler } from "../test/tauri";
import { PromptLibraryWindow } from "./PromptLibraryWindow";

type Prompt = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

type Call = {
  command: string;
  payload?: InvokeArgs;
};

const initialPrompts: Prompt[] = [
  {
    id: "prompt-review",
    title: "代码审查",
    content: "请逐条检查边界条件，并列出可复现的问题。",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "prompt-summary",
    title: "整理需求",
    content: "把下面的需求整理成清晰的执行步骤。",
    createdAt: 2,
    updatedAt: 2,
  },
];

async function renderLibrary(seed: Prompt[] = []) {
  let prompts = structuredClone(seed);
  let saveSequence = 0;
  const calls: Call[] = [];

  const ipc: IPCHandler = (command, payload) => {
    calls.push({ command, payload });
    if (command === "list_saved_prompts") return structuredClone(prompts);
    if (command === "copy_text" || command === "hide_prompt_library") return undefined;
    if (command === "save_saved_prompt") {
      const input = invokeArgs(payload).input as {
        id?: string | null;
        title: string;
        content: string;
      };
      if (input.id) {
        prompts = prompts.map((prompt) =>
          prompt.id === input.id
            ? { ...prompt, title: input.title, content: input.content, updatedAt: prompt.updatedAt + 1 }
            : prompt,
        );
      } else {
        const now = 10 + saveSequence++;
        prompts = [
          {
            id: `prompt-${now}`,
            title: input.title.trim() || input.content.trim().split(/\r?\n/)[0] || "未命名",
            content: input.content,
            createdAt: now,
            updatedAt: now,
          },
          ...prompts,
        ];
      }
      return structuredClone(prompts);
    }
    if (command === "delete_saved_prompt") {
      const id = String(invokeArgs(payload).id);
      prompts = prompts.filter((prompt) => prompt.id !== id);
      return structuredClone(prompts);
    }
    return undefined;
  };

  setupTauriMock(ipc, { currentWindow: "prompt-library", shouldMockEvents: true });
  render(<PromptLibraryWindow />);
  const user = userEvent.setup();
  await screen.findByRole("textbox", { name: "搜索" });
  await screen.findByText(seed.length ? seed[0].title : "这里还空着");
  return {
    calls,
    user,
    replacePrompts(next: Prompt[]) {
      prompts = structuredClone(next);
    },
  };
}

function commandCalls(calls: Call[], command: string) {
  return calls.filter((call) => call.command === command);
}

function row(name: string) {
  return screen.getByRole("article", { name });
}

describe("Prompt 库窗口", () => {
  it("显示持久保存的列表，并在窗口再次打开时重新读取", async () => {
    const library = await renderLibrary(initialPrompts);

    expect(row("代码审查").textContent).toContain("请逐条检查边界条件");
    expect(row("整理需求").textContent).toContain("把下面的需求整理成清晰的执行步骤");
    expect(commandCalls(library.calls, "list_saved_prompts")).toHaveLength(1);

    library.replacePrompts([
      {
        id: "prompt-new",
        title: "新保存的 Prompt",
        content: "再次打开窗口后读取到的新内容。",
        createdAt: 3,
        updatedAt: 3,
      },
    ]);
    await act(async () => {
      await emit("prompt-library-opened");
    });

    expect(await screen.findByRole("article", { name: "新保存的 Prompt" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "代码审查" })).toBeNull();
    expect(commandCalls(library.calls, "list_saved_prompts")).toHaveLength(2);
  });

  it("复制只写入正文并留在列表，搜索与两种空状态都清楚", async () => {
    const library = await renderLibrary(initialPrompts);
    const search = screen.getByRole("textbox", { name: "搜索" });

    await library.user.type(search, "边界条件");
    expect(row("代码审查")).toBeTruthy();
    expect(screen.queryByRole("article", { name: "整理需求" })).toBeNull();

    await library.user.click(within(row("代码审查")).getByRole("button", { name: "复制" }));
    await waitFor(() => {
      expect(commandCalls(library.calls, "copy_text")[0].payload).toEqual({
        text: "请逐条检查边界条件，并列出可复现的问题。",
      });
    });
    expect((await screen.findByRole("status")).textContent).toBe("Prompt 已复制");
    expect(row("代码审查")).toBeTruthy();
    expect(commandCalls(library.calls, "hide_prompt_library")).toHaveLength(0);

    await library.user.clear(search);
    await library.user.type(search, "不存在的关键词");
    expect(await screen.findByText("没有匹配的 Prompt")).toBeTruthy();
    await library.user.click(screen.getByRole("button", { name: "清除" }));
    expect(row("整理需求")).toBeTruthy();
  });

  it("空库可以新建；空正文不能保存，Ctrl/Cmd+S 保存后回到列表", async () => {
    const library = await renderLibrary();
    expect(await screen.findByText("这里还空着")).toBeTruthy();

    await library.user.keyboard("{Control>}n{/Control}");
    expect(await screen.findByRole("heading", { name: "新建" })).toBeTruthy();
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toHaveProperty("disabled", true);

    await library.user.type(screen.getByRole("textbox", { name: "名称" }), "发布检查");
    await library.user.type(screen.getByRole("textbox", { name: "正文" }), "检查变更并列出发布风险。");
    expect(save).toHaveProperty("disabled", false);
    await library.user.keyboard("{Control>}s{/Control}");

    await waitFor(() => expect(commandCalls(library.calls, "save_saved_prompt")).toHaveLength(1));
    expect(invokeArgs(commandCalls(library.calls, "save_saved_prompt")[0].payload)).toEqual({
      input: { id: null, title: "发布检查", content: "检查变更并列出发布风险。" },
    });
    expect(await screen.findByRole("article", { name: "发布检查" })).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toBe("Prompt 已保存");
  });

  it("编辑已有 Prompt 按 id 更新，并通过两次点击删除", async () => {
    const library = await renderLibrary(initialPrompts);

    await library.user.click(within(row("代码审查")).getByRole("button", { name: "编辑" }));
    const content = screen.getByRole("textbox", { name: "正文" });
    await library.user.clear(content);
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    await library.user.type(content, "检查修改后的边界条件。");
    await library.user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(commandCalls(library.calls, "save_saved_prompt")).toHaveLength(1));
    expect(invokeArgs(commandCalls(library.calls, "save_saved_prompt")[0].payload)).toEqual({
      input: {
        id: "prompt-review",
        title: "代码审查",
        content: "检查修改后的边界条件。",
      },
    });
    expect(await screen.findByText("检查修改后的边界条件。")).toBeTruthy();

    await library.user.click(within(row("代码审查")).getByRole("button", { name: "编辑" }));
    await library.user.click(screen.getByRole("button", { name: "删除" }));
    expect(commandCalls(library.calls, "delete_saved_prompt")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "再点一次删除" })).toBeTruthy();
    await library.user.click(screen.getByRole("button", { name: "再点一次删除" }));

    await waitFor(() => expect(commandCalls(library.calls, "delete_saved_prompt")).toHaveLength(1));
    expect(commandCalls(library.calls, "delete_saved_prompt")[0].payload).toEqual({ id: "prompt-review" });
    expect(screen.queryByRole("article", { name: "代码审查" })).toBeNull();
    expect(await screen.findByRole("article", { name: "整理需求" })).toBeTruthy();
  });

  it("Ctrl/Cmd+F 聚焦搜索；Esc 在编辑页返回列表，在列表页收起窗口", async () => {
    const library = await renderLibrary(initialPrompts);
    const search = screen.getByRole("textbox", { name: "搜索" });

    search.blur();
    expect(document.activeElement).not.toBe(search);
    await library.user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(search);

    await library.user.keyboard("{Control>}n{/Control}");
    await library.user.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: "Prompt 库" })).toBeTruthy();
    expect(commandCalls(library.calls, "hide_prompt_library")).toHaveLength(0);

    await library.user.keyboard("{Escape}");
    await waitFor(() => expect(commandCalls(library.calls, "hide_prompt_library")).toHaveLength(1));
  });

  it("窗口再次打开时刷新数据但不丢当前未保存的草稿", async () => {
    const library = await renderLibrary(initialPrompts);
    await library.user.click(within(row("代码审查")).getByRole("button", { name: "编辑" }));
    const content = screen.getByRole("textbox", { name: "正文" });
    await library.user.clear(content);
    await library.user.type(content, "尚未保存的修改");

    await act(async () => {
      await emit("prompt-library-opened");
    });

    expect((screen.getByRole("textbox", { name: "正文" }) as HTMLTextAreaElement).value).toBe("尚未保存的修改");
  });

  it("编辑中按 Ctrl/Cmd+N 不会丢掉当前草稿", async () => {
    const library = await renderLibrary(initialPrompts);
    await library.user.click(within(row("代码审查")).getByRole("button", { name: "编辑" }));
    const content = screen.getByRole("textbox", { name: "正文" });
    await library.user.clear(content);
    await library.user.type(content, "仍需保留的草稿");

    await library.user.keyboard("{Control>}n{/Control}");
    expect(screen.getByRole("heading", { name: "编辑" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "正文" }) as HTMLTextAreaElement).value).toBe("仍需保留的草稿");
    expect(screen.getByRole("alert").textContent).toBe("请先保存或取消当前编辑");
  });
});
