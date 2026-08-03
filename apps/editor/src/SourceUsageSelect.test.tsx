// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createProject,
  sourceUsageSchema,
  type PresentationProject,
  type SourceAsset,
} from "@slide-maker/core";
import { SourcePanel } from "./SourcePanel.js";

/**
 * 來源卡片上的「生成用途」下拉與它底下那一行說明。
 *
 * 這一組釘的是**看得到／選得到**：`sourceUsageSchema` 多一個值時，伺服器立刻吃得下它，
 * 但畫面上那幾個 `<option>` 以前是手寫的第二份清單——漏掉一個不會有任何東西變紅，結果是
 * 「這個用途存在、後端也支援，但使用者選不到」。說明那一行同理：它講的是「選了會發生
 * 什麼事」，綁錯 id 的話讀屏念完選項就沒了。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const now = new Date().toISOString();

const source = (patch: Partial<SourceAsset> & { id: string }): SourceAsset => ({
  name: `${patch.id}.md`,
  mediaType: "text/markdown",
  usage: "content",
  allowModelAccess: true,
  status: "indexed",
  assetPath: `assets/sources/${patch.id}`,
  sizeBytes: 2048,
  extractedText: "",
  chunks: [],
  metadata: {},
  createdAt: now,
  ...patch,
});

function projectWith(...sources: SourceAsset[]): PresentationProject {
  const project = createProject({ topic: "大綱參考", brief: { desiredSlideCount: 1 } });
  project.workflowStage = "editing";
  project.sources = sources;
  return project;
}

const usageSelect = (name: string) => screen.getByRole("combobox", { name: `${name} 的生成用途` });

describe("生成用途的下拉選單", () => {
  it("六個用途全部選得到，順序與 schema 的宣告順序一致", () => {
    render(
      <SourcePanel
        project={projectWith(source({ id: "a" }))}
        onProject={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const options = [...usageSelect("a.md").querySelectorAll("option")];
    // 與 schema 對齊而不是只寫一份字面清單：兩邊都手寫的話，enum 多一個值時這個測試會跟著
    // 舊清單一起過期，正好漏掉它要防的那件事。
    expect(options.map((option) => option.value)).toEqual([...sourceUsageSchema.options]);
    // 順序本身也是規格：`content` 之後緊接 `outline-reference`（語意最近——它同時仍是一份
    // 內容依據），三個圖片用途再接在後面。
    expect(options.map((option) => option.value)).toEqual([
      "content",
      "outline-reference",
      "visual-reference",
      "style-reference",
      "direct-asset",
      "exclude-from-generation",
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      "內容依據",
      "大綱參考",
      "視覺參考",
      "風格參考",
      "直接素材",
      "不參與生成",
    ]);
    // `<option>` 只放標籤：說明塞進來會把下拉撐到整個面板寬（說明本身走下面那一行小字）。
    for (const option of options) expect(option.textContent!.length).toBeLessThan(10);
  });

  it("切成「大綱參考」只送出用途，且不會問「要不要讓 AI 讀圖」", async () => {
    // 刻意用一張**還沒有描述的 PNG**：這正是改成「視覺參考」時會跳確認框的形狀，換成
    // 文字檔的話這個測試恆綠（那條路本來就不會問）。
    const image = source({
      id: "chart",
      name: "手寫大綱.png",
      mediaType: "image/png",
      usage: "content",
    });
    const project = projectWith(image);
    const patches: Record<string, unknown>[] = [];
    const asked = vi.fn(() => true);
    vi.stubGlobal("confirm", asked);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== "PATCH") return Response.json(project);
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json(project);
      }),
    );
    const onError = vi.fn();
    render(<SourcePanel project={project} onProject={vi.fn()} onError={onError} />);

    fireEvent.change(usageSelect("手寫大綱.png"), { target: { value: "outline-reference" } });

    await waitFor(() => expect(patches).toHaveLength(1));
    // 大綱參考是純文字的結構指示：不附圖、也不該因為它去燒一次視覺模型的配額。
    expect(patches[0]).toEqual({ usage: "outline-reference" });
    expect(asked).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // 正向對照：同一張圖改成「視覺參考」確實會問——上面那一行才不是「confirm 根本沒接上」。
    fireEvent.change(usageSelect("手寫大綱.png"), { target: { value: "visual-reference" } });
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(patches[1]).toEqual({ usage: "visual-reference", describeImage: true });
  });
});

describe("下拉底下那一行說明", () => {
  it("以 aria-describedby 綁在 select 上，內容跟著目前的用途走", () => {
    const { rerender } = render(
      <SourcePanel
        project={projectWith(source({ id: "a", name: "大綱.md" }))}
        onProject={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const readHint = () => {
      const select = usageSelect("大綱.md");
      const id = select.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      // 指到一個真的存在的節點才有用：`aria-describedby` 指向不存在的 id 時，讀屏什麼都
      // 不會念，而畫面上那行字看起來一切正常。
      const hint = document.getElementById(id!);
      expect(hint).toBeTruthy();
      return hint!.textContent ?? "";
    };

    // 「內容依據」講的是它的文字會被讀去寫大綱。
    expect(readHint()).toContain("寫大綱");

    rerender(
      <SourcePanel
        project={projectWith(source({ id: "a", name: "大綱.md", usage: "outline-reference" }))}
        onProject={vi.fn()}
        onError={vi.fn()}
      />,
    );
    const outlineHint = readHint();
    // 這一句要同時回答兩件使用者一定會問的事：它決定編排、而且它**仍然**算內容依據。
    expect(outlineHint).toMatch(/章節|編排/);
    expect(outlineHint).toContain("內容依據");

    rerender(
      <SourcePanel
        project={projectWith(source({ id: "a", name: "大綱.md", usage: "direct-asset" }))}
        onProject={vi.fn()}
        onError={vi.fn()}
      />,
    );
    // 每一種用途的說明都不一樣（不是同一句話貼六次）。
    expect(readHint()).not.toBe(outlineHint);
    expect(readHint()).toContain("原樣");
  });

  it("同一頁多張卡片時，每張的說明 id 唯一且各自對到自己那張", () => {
    // 專案上限 200 份來源＝同一頁可以有 200 張卡片。id 撞在一起時
    // `document.getElementById` 只會拿到第一個，每一張卡片的讀屏描述都會變成第一張的用途。
    render(
      <SourcePanel
        project={projectWith(
          source({ id: "s1", name: "第一份.md", usage: "content" }),
          source({ id: "s2", name: "第二份.md", usage: "outline-reference" }),
          source({
            id: "s3",
            name: "第三份.png",
            mediaType: "image/png",
            usage: "style-reference",
          }),
        )}
        onProject={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const ids = ["第一份.md", "第二份.md", "第三份.png"].map((name) =>
      usageSelect(name).getAttribute("aria-describedby"),
    );
    expect(new Set(ids).size).toBe(3);
    const hints = ids.map((id) => document.getElementById(id!)?.textContent ?? "");
    // 三張卡片三種用途，說明也必須是三句不同的話——共用一個 id 時這三句會全部相同。
    expect(new Set(hints).size).toBe(3);
    expect(hints[1]).toMatch(/章節|編排/);
    expect(hints[2]).toContain("風格");
  });
});
