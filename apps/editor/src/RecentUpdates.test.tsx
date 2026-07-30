// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecentUpdatesButton } from "./RecentUpdates.js";
import { changelogDays, formatChangelogDate } from "./changelog.js";

/**
 * 面板本身沒有狀態要同步、也不打 API，能出錯的只有「開得起來、關得掉、關掉之後鍵盤
 * 還在原地」——三種關閉路徑（關閉鈕／Esc／點背景）逐一釘住，另外釘住點內容**不會**關，
 * 那是最容易在改 backdrop 事件時弄壞的一條。
 */

afterEach(cleanup);

const trigger = () => screen.getByRole("button", { name: "最近更新" });
const dialog = () => screen.queryByRole("dialog");
const backdrop = () => {
  const element = document.querySelector(".recent-updates-backdrop");
  if (!element) throw new Error("遮罩不存在");
  return element;
};

/**
 * 照瀏覽器的真實順序派送一次「按下 → 放開 → click」。起點與終點不同時，`click` 會落在
 * 兩者的共同祖先上——這裡一律是遮罩，那正是 `onClick` 版本會誤關的原因。
 */
function press(down: Element, up: Element) {
  fireEvent.mouseDown(down);
  fireEvent.mouseUp(up);
  fireEvent.click(down === up ? down : backdrop());
}

const open = () => {
  render(<RecentUpdatesButton />);
  fireEvent.click(trigger());
};

describe("RecentUpdatesButton", () => {
  it("點按鈕打開 modal，看得到日期標題與項目內容", () => {
    open();
    const panel = dialog();
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    // aria-labelledby 指到的必須真的是那個標題節點。
    const labelId = panel?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelId)?.textContent).toBe("最近更新");

    const newest = changelogDays[0];
    expect(newest).toBeDefined();
    expect(screen.getByText(formatChangelogDate(newest?.date ?? ""))).toBeDefined();
    const firstEntry = newest?.entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry?.title) expect(screen.getByText(firstEntry.title).tagName).toBe("STRONG");
    expect(panel?.textContent).toContain(firstEntry?.body ?? "");
  });

  it("開啟時焦點在 modal 內，關閉鈕可以關掉且焦點回到按鈕", () => {
    open();
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "關閉" }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Esc 關得掉，焦點回到按鈕", () => {
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("在背景按下並放開才關得掉，點內容不會關", () => {
    open();
    const panel = screen.getByRole("dialog");
    press(panel, panel);
    expect(dialog()).not.toBeNull();

    press(backdrop(), backdrop());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  /**
   * 在內文按住、拖到遮罩上放開＝複製更新紀錄時最自然的動作。瀏覽器此時把 `click` 派送到
   * 兩者的**共同祖先**（＝遮罩本身），所以只看 `onClick` 的版本會在放開的瞬間關掉面板、
   * 連選到的字一起沒收；內容層的 `stopPropagation` 也擋不住，因為事件 target 就是遮罩。
   *
   * `press()` 因此連 `click` 一起派送：只送 mousedown／mouseup 的話，退回 `onClick` 的
   * 實作在 jsdom 裡不會收到任何事件、這一則會假綠＝等於沒測（已用改壞原始碼實測確認）。
   */
  it("從內文拖曳選字、放開在遮罩上時不關（反向也不關）", () => {
    open();
    const panel = screen.getByRole("dialog");
    press(panel, backdrop());
    expect(dialog()).not.toBeNull();

    press(backdrop(), panel);
    expect(dialog()).not.toBeNull();
  });

  it("開著時鎖住背景捲動，關閉與卸載都還原", () => {
    document.body.style.overflow = "scroll";
    const view = render(<RecentUpdatesButton />);
    fireEvent.click(trigger());
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.body.style.overflow).toBe("scroll");

    // 卸載路徑：面板還開著就整棵樹被拆掉（換路由），cleanup 一樣要還原。
    fireEvent.click(trigger());
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });

  /**
   * 釘住「modal 掛在 body、不在 header 裡」這個決定。
   *
   * 真正的缺陷是幾何的：`.dashboard-header` 有 `backdrop-filter: blur(14px)`，會成為
   * fixed 後代的 containing block，就地渲染時覆蓋層的 `inset: 0` 只解析出 header 那條
   * 64px（實測面板 y=-236，標題被切掉）。但 jsdom 不套外部樣式表、也不實作
   * `backdrop-filter` 的 containing block，量 rect 一律回 0——所以這裡測的是**掛載位置**
   * 這個可觀察的決定，而不是量不到的幾何。把 `createPortal` 「簡化」掉就會紅。
   */
  it("modal 掛在 document.body 底下，不在 header 的子樹裡", () => {
    render(
      <div className="dashboard">
        <header className="dashboard-header">
          <RecentUpdatesButton />
        </header>
      </div>,
    );
    fireEvent.click(trigger());
    const panel = screen.getByRole("dialog");
    const header = document.querySelector(".dashboard-header");
    expect(header).not.toBeNull();
    expect(header?.contains(panel)).toBe(false);
    expect(panel.closest(".recent-updates-backdrop")?.parentElement).toBe(document.body);
    // 觸發按鈕留在 header 裡，不跟著搬家。
    expect(header?.contains(trigger())).toBe(true);
  });

  it("關掉之後 Esc 不會再有殘留的監聽器影響", () => {
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog()).toBeNull();
  });

  it("沒有任何更新紀錄時顯示說明而不是空面板", () => {
    render(<RecentUpdatesButton days={[]} />);
    fireEvent.click(trigger());
    expect(screen.getByText("尚無更新紀錄。")).toBeDefined();
  });
});
