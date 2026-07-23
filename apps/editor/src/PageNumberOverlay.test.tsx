// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  createProject,
  pageNumberLayout,
  type PageNumberSettings,
  type PresentationProject,
} from "@slide-maker/core";
import { PageNumberOverlay } from "./Editor.js";

afterEach(cleanup);

function project(
  slideCount: number,
  pageNumber: Partial<Omit<PageNumberSettings, "background">> & {
    background?: Partial<PageNumberSettings["background"]>;
  } = {},
): PresentationProject {
  const base = createProject({ topic: "頁碼疊層", brief: { desiredSlideCount: slideCount } });
  return {
    ...base,
    pageNumber: {
      ...base.pageNumber,
      ...pageNumber,
      background: { ...base.pageNumber.background, ...pageNumber.background },
    },
  };
}

const layer = () => document.querySelector(".page-number-layer");
const text = () => document.querySelector<HTMLElement>(".page-number-text");
const chip = () => document.querySelector<HTMLElement>(".page-number-chip");

describe("PageNumberOverlay 何時該畫、何時不該畫", () => {
  it("關閉時任何一頁都不渲染任何節點", () => {
    const deck = project(4, { enabled: false });
    for (const index of [0, 1, 3]) {
      const { container } = render(<PageNumberOverlay project={deck} index={index} />);
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });

  it("跳過封面時第一頁不渲染，第二頁起才有", () => {
    const deck = project(3, { enabled: true, skipFirstSlide: true });
    render(<PageNumberOverlay project={deck} index={0} />);
    expect(layer()).toBeNull();
    cleanup();

    render(<PageNumberOverlay project={deck} index={1} />);
    expect(text()?.textContent).toBe("1");
  });

  it("不跳封面時封面就是第一個頁碼", () => {
    render(
      <PageNumberOverlay
        project={project(3, { enabled: true, skipFirstSlide: false })}
        index={0}
      />,
    );
    expect(text()?.textContent).toBe("1");
  });

  it("只有一頁又跳過封面時，整份簡報不渲染頁碼", () => {
    render(
      <PageNumberOverlay project={project(1, { enabled: true, skipFirstSlide: true })} index={0} />,
    );
    expect(layer()).toBeNull();
  });
});

describe("PageNumberOverlay 的內容與匯出用的同一份計算", () => {
  it("number-total 的分母是最後一頁的數字，末頁分子等於分母", () => {
    const deck = project(3, { enabled: true, format: "number-total", skipFirstSlide: true });
    render(<PageNumberOverlay project={deck} index={1} />);
    expect(text()?.textContent).toBe("1 / 2");
    cleanup();

    render(<PageNumberOverlay project={deck} index={2} />);
    expect(text()?.textContent).toBe("2 / 2");
  });

  it("startAt 平移前端顯示，與 zh-page 格式並用也一致", () => {
    const deck = project(4, {
      enabled: true,
      format: "zh-page",
      startAt: 10,
      skipFirstSlide: true,
    });
    render(<PageNumberOverlay project={deck} index={1} />);
    expect(text()?.textContent).toBe("第 10 頁");
    cleanup();

    render(<PageNumberOverlay project={deck} index={3} />);
    expect(text()?.textContent).toBe("第 12 頁");
  });

  it("幾何是 pageNumberLayout 的百分比換算，預覽才會與匯出落點一致", () => {
    const deck = project(3, { enabled: true, position: "bottom-center", fontSize: 48 });
    const expected = pageNumberLayout(deck.pageNumber, deck.canvas, "1");
    render(<PageNumberOverlay project={deck} index={1} />);

    const style = text()!.style;
    expect(style.left).toBe(`${(expected.text.x / deck.canvas.width) * 100}%`);
    expect(style.top).toBe(`${(expected.text.y / deck.canvas.height) * 100}%`);
    expect(style.width).toBe(`${(expected.text.width / deck.canvas.width) * 100}%`);
    expect(style.height).toBe(`${(expected.text.height / deck.canvas.height) * 100}%`);
  });

  it("三種位置對應三種水平對齊", () => {
    for (const [position, justify] of [
      ["bottom-left", "flex-start"],
      ["bottom-center", "center"],
      ["bottom-right", "flex-end"],
    ] as const) {
      render(<PageNumberOverlay project={project(3, { enabled: true, position })} index={1} />);
      expect(text()!.style.justifyContent, position).toBe(justify);
      cleanup();
    }
  });
});

describe("PageNumberOverlay 的色塊", () => {
  it("關閉色塊時不渲染 chip 節點", () => {
    render(
      <PageNumberOverlay
        project={project(3, { enabled: true, background: { enabled: false } })}
        index={1}
      />,
    );
    expect(text()).not.toBeNull();
    expect(chip()).toBeNull();
  });

  it("開啟色塊時 chip 的幾何與顏色都來自同一份 layout", () => {
    const deck = project(3, {
      enabled: true,
      background: { enabled: true, color: "#123456", opacity: 0.5 },
    });
    const expected = pageNumberLayout(deck.pageNumber, deck.canvas, "1").chip!;
    render(<PageNumberOverlay project={deck} index={1} />);

    const style = chip()!.style;
    expect(style.left).toBe(`${(expected.x / deck.canvas.width) * 100}%`);
    expect(style.width).toBe(`${(expected.width / deck.canvas.width) * 100}%`);
    expect(style.height).toBe(`${(expected.height / deck.canvas.height) * 100}%`);
    expect(style.opacity).toBe("0.5");
    expect(style.background).toBe("rgb(18, 52, 86)");
    // 色塊必須墊在字底下：DOM 順序決定堆疊，chip 要排在 text 之前。
    expect(layer()!.firstElementChild).toBe(chip());
  });
});
