// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelLibrary } from "./ModelLibrary.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 影像庫含一個 local kind（fullSlideGeneration:false 的抹字工具）與一個 mock 生圖模型，
// 外加一個已存在的組合，讓 CombinationRow 的影像下拉渲染出來。
const libraryWithLocalImage = () => ({
  schemaVersion: 1 as const,
  connections: [],
  models: [
    {
      id: "local-inpaint",
      name: "OpenCV 抹字修補（本機）",
      capability: "image",
      providerKind: "local",
      model: "opencv-inpaint-telea",
    },
    {
      id: "mock-image",
      name: "Mock 生圖",
      capability: "image",
      providerKind: "mock",
      model: "mock",
    },
  ],
  combinations: [{ id: "combo-1", name: "預設組合", imageModelRef: "mock-image" }],
  defaultCombinationId: "combo-1",
  system: {},
  updatedAt: new Date().toISOString(),
});

describe("ModelLibrary 組合影像下拉", () => {
  it("排除 local kind（如 local-inpaint），只列可整頁生成的影像模型", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/model-library") return Response.json(libraryWithLocalImage());
      return Response.json({ error: "UNEXPECTED_REQUEST" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelLibrary onNavigate={() => {}} />);

    // 以既有組合的名稱（value）為錨點定位到 CombinationRow——「新增組合」表單也有一個
    // aria-label 相同的空白輸入，故用 display value 區分；再取其影像下拉（三個 select 依序
    // image/text/search）。
    const comboName = await screen.findByDisplayValue("預設組合");
    const comboRow = comboName.closest(".model-library-combo") as HTMLElement;
    const imageSelect = within(comboRow).getAllByRole("combobox")[0] as HTMLSelectElement;
    const optionLabels = [...imageSelect.options].map((option) => option.textContent);

    // local-inpaint 綁進組合的影像模型必然在生成時失敗，故不得出現在下拉。
    expect(optionLabels).toContain("Mock 生圖");
    expect(optionLabels).not.toContain("OpenCV 抹字修補（本機）");
  });
});

/** 一條連線 + 兩個引用它的模型 + 一個引用其中一個模型的組合，用來驗確認文案裡的影響範圍。 */
const libraryWithConnection = () => ({
  schemaVersion: 1 as const,
  connections: [
    {
      id: "conn-1",
      name: "本機 Proxy",
      protocol: "openai" as const,
      baseUrl: "http://localhost:8317/v1",
      apiKey: "",
    },
  ],
  models: [
    {
      id: "text-1",
      name: "GPT 文字",
      capability: "text",
      providerKind: "openai",
      model: "gpt-5",
      connectionRef: "conn-1",
    },
    {
      id: "image-1",
      name: "GPT 影像",
      capability: "image",
      providerKind: "openai",
      model: "gpt-image-2",
      connectionRef: "conn-1",
    },
  ],
  combinations: [{ id: "combo-1", name: "預設組合", textModelRef: "text-1" }],
  defaultCombinationId: "combo-1",
  system: {},
  updatedAt: new Date().toISOString(),
});

/**
 * image-1（影像 entry）的可調項，形狀比照伺服器 `GET /api/model-library/image-options`
 * ——那份清單由 provider 宣告，前端只負責渲染，所以測試也從外面餵進來。
 */
const imageOptionSets = {
  "image-1": {
    id: "gpt-image",
    label: "gpt-image 系列",
    fields: [
      {
        kind: "select" as const,
        id: "size",
        label: "輸出尺寸",
        unsetLabel: "1536x1024（模型預設）",
        choices: [
          { id: "1536x1024", label: "1536×1024（橫向）" },
          { id: "1024x1024", label: "1024×1024（方形）" },
        ],
      },
    ],
  },
};

/**
 * 只回應模型庫、/models 探測與影像可調項；其餘一律 404，讓「不該送出的請求」在斷言前就
 * 無法成立。`options` 傳 `{}` 可以模擬「這個模型沒有已知可調項」。
 */
function stubLibraryFetch(library: unknown, options: unknown = imageOptionSets) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    if (path === "/api/model-library" && !init?.method) return Response.json(library);
    if (path === "/api/model-library/image-options") return Response.json({ options });
    if (path.endsWith("/models") && path.startsWith("/api/model-library/connections"))
      return Response.json({ models: [] });
    return Response.json({ error: "UNEXPECTED_REQUEST" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const writeRequests = (fetchMock: ReturnType<typeof stubLibraryFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

describe("ModelLibrary 破壞性操作的確認", () => {
  it("刪除連線要先確認，且文案講得出有幾個模型正在使用它", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    // 取消 → 一個寫入請求都不該送出。後果是延遲的（懸空 ref 要到下次生成才爆），
    // 所以「按了沒反應」在這裡等於資料已經壞掉。
    const confirmMock = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirmMock);

    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    // 用 class 定位而不是 display value：「本機 Proxy」在模型列的連線下拉裡也是選中的值。
    await waitFor(() =>
      expect(container.querySelector(".model-library-connection-row")).toBeTruthy(),
    );
    const connectionRow = container.querySelector(".model-library-connection-row") as HTMLElement;
    fireEvent.click(within(connectionRow).getByRole("button", { name: "刪除" }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const message = String(confirmMock.mock.calls[0]?.[0]);
    expect(message).toContain("本機 Proxy");
    expect(message).toContain("2 個模型");
    expect(message).toContain("GPT 文字");
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("刪除模型要先確認，且文案講得出有幾個組合正在使用它", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    const confirmMock = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirmMock);

    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    const selector = ".model-library-group.cap-text .model-library-row";
    await waitFor(() => expect(container.querySelector(selector)).toBeTruthy());
    const modelRow = container.querySelector(selector) as HTMLElement;
    fireEvent.click(within(modelRow).getByRole("button", { name: "刪除" }));

    const message = String(confirmMock.mock.calls[0]?.[0]);
    expect(message).toContain("GPT 文字");
    expect(message).toContain("1 個組合");
    expect(message).toContain("預設組合");
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });
});

describe("ModelLibrary 送出前的欄位驗證", () => {
  it("openai 模型缺少 model id 與連線時就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);

    const createBox = (await screen.findByRole("button", { name: "新增模型" })).closest(
      ".model-library-create",
    ) as HTMLElement;
    fireEvent.change(within(createBox).getByLabelText("模型名稱"), {
      target: { value: "新模型" },
    });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增模型" }));

    // 訊息必須落在出問題的那個欄位旁邊，不是頁頂 toast。
    const modelField = within(createBox).getByLabelText("模型名").parentElement as HTMLElement;
    expect(within(modelField).getByRole("alert").textContent).toMatch(/模型 id/);
    const connectionField = within(createBox).getByLabelText("連線").parentElement as HTMLElement;
    expect(within(connectionField).getByRole("alert").textContent).toMatch(/一定要指定連線/);
    expect(writeRequests(fetchMock)).toHaveLength(0);

    // 補齊之後就送得出去（錯誤字也跟著消失）。
    fireEvent.change(within(createBox).getByLabelText("模型名"), { target: { value: "gpt-5" } });
    fireEvent.change(within(createBox).getByLabelText("連線"), { target: { value: "conn-1" } });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增模型" }));
    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(1));
  });

  it("base URL 缺協定／留空都在該欄位就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);

    const createBox = (await screen.findByRole("button", { name: "新增連線" })).closest(
      ".model-library-create",
    ) as HTMLElement;
    const baseUrlField = within(createBox).getByLabelText("Base URL").parentElement as HTMLElement;

    // 「新增」刻意可按（移除了 disabled={!name.trim()}），所以缺漏必須在按下去之後就地講明。
    fireEvent.change(within(createBox).getByLabelText("連線名稱"), {
      target: { value: "新連線" },
    });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增連線" }));
    expect(within(baseUrlField).getByRole("alert").textContent).toMatch(/請輸入 base URL/);
    expect(writeRequests(fetchMock)).toHaveLength(0);

    // 相對路徑／缺協定在執行期只會變成一句難懂的 fetch 例外，且要等到某天生成時才爆。
    fireEvent.change(within(createBox).getByLabelText("Base URL"), {
      target: { value: "localhost:8317/v1" },
    });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增連線" }));
    expect(within(baseUrlField).getByRole("alert").textContent).toMatch(/http／https/);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  /*
    三個建立表單都刻意移除了 `disabled={!name.trim()}`（按不下去的按鈕不會告訴任何人少了
    什麼），於是「名稱空白」這條路完全靠 `validate()` 擋。這三個案例補的正是它：先前把三個
    validate 裡的名稱檢查全部刪掉，整個測試檔仍然全綠，而按下去會真的送出
    `{"name":""}`——伺服器的 `z.string().trim().min(1)` 會回 400，使用者拿到的是一句通用的
    伺服器錯誤，而移除 disabled 的全部意義就是要讓提示出現在欄位旁邊。

    「fetch 對建立端點的呼叫次數為 0」那半是承重的：少了它，就算請求真的送出去，
    畫面上仍會有一句就地訊息（伺服器 400 的訊息也會落在同一個位置），測試照樣會過。
  */
  it("連線名稱留空時就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);

    const createBox = (await screen.findByRole("button", { name: "新增連線" })).closest(
      ".model-library-create",
    ) as HTMLElement;
    // base URL 填好，確保被擋下的原因只有名稱。
    fireEvent.change(within(createBox).getByLabelText("Base URL"), {
      target: { value: "http://localhost:8317/v1" },
    });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增連線" }));

    const nameField = within(createBox).getByLabelText("連線名稱").parentElement as HTMLElement;
    expect(within(nameField).getByRole("alert").textContent).toMatch(/請輸入名稱/);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("模型名稱留空時就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);

    const createBox = (await screen.findByRole("button", { name: "新增模型" })).closest(
      ".model-library-create",
    ) as HTMLElement;
    // 其餘必填一併補齊，確保被擋下的原因只有名稱。
    fireEvent.change(within(createBox).getByLabelText("連線"), { target: { value: "conn-1" } });
    fireEvent.change(within(createBox).getByLabelText("模型名"), { target: { value: "gpt-5" } });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增模型" }));

    const nameField = within(createBox).getByLabelText("模型名稱").parentElement as HTMLElement;
    expect(within(nameField).getByRole("alert").textContent).toMatch(/請輸入名稱/);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("組合名稱留空時就地報錯，且不送出請求", async () => {
    // `CombinationsSection` 的驗證**只有**名稱檢查，所以少了這個案例它整條 validate 路徑零覆蓋。
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);

    const createBox = (await screen.findByRole("button", { name: "新增組合" })).closest(
      ".model-library-create",
    ) as HTMLElement;
    fireEvent.click(within(createBox).getByRole("button", { name: "新增組合" }));

    const nameField = within(createBox).getByLabelText("組合名稱").parentElement as HTMLElement;
    expect(within(nameField).getByRole("alert").textContent).toMatch(/請輸入名稱/);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("既有連線的 base URL 被清空時就地報錯，且不送出請求", async () => {
    // 建立那邊早就擋了，儲存這邊卻沒有：同一個「延遲到下次生成才爆」的陷阱換一個畫面出現。
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector(".model-library-connection-row")).toBeTruthy(),
    );
    const row = container.querySelector(".model-library-connection-row") as HTMLElement;

    fireEvent.change(within(row).getByLabelText("Base URL"), { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));

    expect(
      within(row)
        .getAllByRole("alert")
        .some((node) => /請輸入 base URL/.test(node.textContent ?? "")),
    ).toBe(true);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("既有連線改成非 HTTP 完整網址時就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector(".model-library-connection-row")).toBeTruthy(),
    );
    const row = container.querySelector(".model-library-connection-row") as HTMLElement;

    fireEvent.change(within(row).getByLabelText("Base URL"), {
      target: { value: "localhost:8317/v1" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));

    expect(
      within(row)
        .getAllByRole("alert")
        .some((node) => /http／https/.test(node.textContent ?? "")),
    ).toBe(true);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("既有連線的逾時改成非數字時就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector(".model-library-connection-row")).toBeTruthy(),
    );
    const row = container.querySelector(".model-library-connection-row") as HTMLElement;

    fireEvent.change(within(row).getByLabelText("連線逾時"), { target: { value: "abc" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));

    expect(
      within(row)
        .getAllByRole("alert")
        .some((node) => /只接受數字/.test(node.textContent ?? "")),
    ).toBe(true);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("儲存連線會送出逾時；清空則送 null 以沿用系統設定", async () => {
    const base = libraryWithConnection();
    const fetchMock = stubLibraryFetch({
      ...base,
      connections: [{ ...base.connections[0]!, timeoutMs: 180_000 }],
    });
    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector(".model-library-connection-row")).toBeTruthy(),
    );
    const row = container.querySelector(".model-library-connection-row") as HTMLElement;

    fireEvent.change(within(row).getByLabelText("連線逾時"), { target: { value: "600000" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeRequests(fetchMock)[0]?.[1]?.body))).toMatchObject({
      timeoutMs: 600000,
    });

    fireEvent.change(within(row).getByLabelText("連線逾時"), { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(2));
    expect(JSON.parse(String(writeRequests(fetchMock)[1]?.[1]?.body))).toMatchObject({
      timeoutMs: null,
    });
  });

  it("系統設定的數字欄位擋掉非數字，不讓 NaN 送到伺服器", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);

    fireEvent.change(await screen.findByLabelText("模型逾時"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存系統設定" }));

    expect(screen.getByRole("alert").textContent).toMatch(/只接受數字/);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });
});

describe("ModelLibrary 影像參數", () => {
  /** 影像 entry 那一列；`libraryWithConnection` 裡是 image-1（openai／gpt-image-2）。 */
  const imageRow = async (): Promise<HTMLElement> => {
    await waitFor(() => expect(screen.getAllByLabelText("模型名稱").length).toBeGreaterThan(0));
    const nameInput = screen
      .getAllByLabelText("模型名稱")
      .find((node) => (node as HTMLInputElement).value === "GPT 影像") as HTMLElement;
    return nameInput.closest(".model-library-row") as HTMLElement;
  };

  it("渲染的是伺服器給的可調項，選了就照那個欄位 id 送出", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);
    const row = await imageRow();

    // 欄位與選項都來自 provider 的宣告，前端不認得「輸出尺寸」是什麼意思。
    await waitFor(() => expect(within(row).queryByLabelText("輸出尺寸")).toBeTruthy());
    const select = within(row).getByLabelText("輸出尺寸") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "1536x1024（模型預設）",
      "1536×1024（橫向）",
      "1024×1024（方形）",
    ]);

    fireEvent.change(select, { target: { value: "1024x1024" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeRequests(fetchMock)[0]?.[1]?.body))).toMatchObject({
      imageProfile: { options: { size: "1024x1024" } },
    });
  });

  it("選回「模型預設」時整個欄位拿掉，全部留白就送 null", async () => {
    const base = libraryWithConnection();
    const fetchMock = stubLibraryFetch({
      ...base,
      models: base.models.map((entry) =>
        entry.id === "image-1"
          ? { ...entry, imageProfile: { options: { size: "1024x1024" } } }
          : entry,
      ),
    });
    render(<ModelLibrary onNavigate={() => {}} />);
    const row = await imageRow();
    await waitFor(() => expect(within(row).queryByLabelText("輸出尺寸")).toBeTruthy());

    // 存一個空字串的話，伺服器拿它去比對 provider 宣告的選項會落空——選回預設就是整個拿掉。
    fireEvent.change(within(row).getByLabelText("輸出尺寸"), { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(1));
    const body = JSON.parse(String(writeRequests(fetchMock)[0]?.[1]?.body)) as {
      imageProfile: unknown;
    };
    // 送 undefined 的話 key 會在 JSON 裡消失，PATCH 就變成「不動這個欄位」。
    expect(body.imageProfile).toBeNull();
  });

  it("沒有已知可調項的模型不給假選項", async () => {
    stubLibraryFetch(libraryWithConnection(), {});
    render(<ModelLibrary onNavigate={() => {}} />);
    const row = await imageRow();
    // 列一個端點不吃的值，使用者選了只會拿到不透明的 400——所以什麼都不列。
    await waitFor(() => expect(within(row).getByText(/沒有已知的可調項/)).toBeTruthy());
    expect(within(row).queryByLabelText("輸出尺寸")).toBeNull();
  });

  it("儲存成功之後「儲存」按鈕就回到停用，不會一直顯示成有未存的變更", async () => {
    const base = libraryWithConnection();
    const saved = {
      ...base,
      models: base.models.map((entry) =>
        entry.id === "image-1"
          ? { ...entry, imageProfile: { options: { size: "1024x1024" } } }
          : entry,
      ),
    };
    // PATCH 回傳的那份會直接成為畫面上的 library，所以 dirty 必須是拿它來比。
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/model-library" && !init?.method) return Response.json(base);
      if (path === "/api/model-library/image-options")
        return Response.json({ options: imageOptionSets });
      if (init?.method === "PATCH" && path.startsWith("/api/model-library/models/"))
        return Response.json(saved);
      if (path.endsWith("/models") && path.startsWith("/api/model-library/connections"))
        return Response.json({ models: [] });
      return Response.json({ error: "UNEXPECTED_REQUEST" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ModelLibrary onNavigate={() => {}} />);
    const row = await imageRow();
    await waitFor(() => expect(within(row).queryByLabelText("輸出尺寸")).toBeTruthy());

    expect((within(row).getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(within(row).getByLabelText("輸出尺寸"), { target: { value: "1024x1024" } });
    expect((within(row).getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));

    // 這一列以 entry.id 當 React key，存檔後只換 entry prop、不會 remount——把初始值凍在
    // useState 裡的話，存成功了按鈕仍會一直亮著，使用者只能靠把每一格手動改回原值才消掉。
    await waitFor(() =>
      expect(
        (within(row).getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("進階欄位不是數字時就地報錯，且不送出請求", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);
    const row = await imageRow();

    fireEvent.change(within(row).getByLabelText("參考圖上限"), { target: { value: "abc" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));
    expect(
      within(row)
        .getAllByRole("alert")
        .some((node) => /只接受數字/.test(node.textContent ?? "")),
    ).toBe(true);
    expect(writeRequests(fetchMock)).toHaveLength(0);
  });

  it("並行生成數超過 32 就地報錯——jobs.ts 對超出範圍是丟例外，整批生成會在排程時就死", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);
    const row = await imageRow();

    fireEvent.change(within(row).getByLabelText("並行生成數"), { target: { value: "33" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));
    expect(
      within(row)
        .getAllByRole("alert")
        .some((node) => /最多 32/.test(node.textContent ?? "")),
    ).toBe(true);
    expect(writeRequests(fetchMock)).toHaveLength(0);

    fireEvent.change(within(row).getByLabelText("並行生成數"), { target: { value: "4" } });
    fireEvent.click(within(row).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeRequests(fetchMock)[0]?.[1]?.body))).toMatchObject({
      imageProfile: { maxConcurrency: 4 },
    });
  });

  it("系統設定的影像並行數是全局預設，模型自己填了就以模型的為準", async () => {
    const fetchMock = stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("影像並行數")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("影像並行數"), { target: { value: "33" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存系統設定" }));
    expect(writeRequests(fetchMock)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("影像並行數"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存系統設定" }));
    await waitFor(() => expect(writeRequests(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeRequests(fetchMock)[0]?.[1]?.body))).toMatchObject({
      imageConcurrency: 6,
    });
  });

  it("文字模型那一列沒有影像參數欄位", async () => {
    stubLibraryFetch(libraryWithConnection());
    render(<ModelLibrary onNavigate={() => {}} />);
    // 「GPT 文字」也是組合那條文字下拉的選中值，故限定成模型列上的名稱輸入框。
    await waitFor(() => expect(screen.getAllByLabelText("模型名稱").length).toBeGreaterThan(0));
    const nameInput = screen
      .getAllByLabelText("模型名稱")
      .find((node) => (node as HTMLInputElement).value === "GPT 文字") as HTMLElement;
    const row = nameInput.closest(".model-library-row") as HTMLElement;
    expect(within(row).queryByText("影像參數")).toBeNull();
  });
});

describe("ModelLibrary 寫入失敗只被回報一次", () => {
  it("就地顯示在該區塊，且不再另外長出一顆 toast", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/model-library" && !init?.method)
        return Response.json(libraryWithConnection());
      if (path.endsWith("/models") && path.startsWith("/api/model-library/connections"))
        return Response.json({ models: [] });
      return Response.json(
        { error: "CONNECTION_WRITE_FAILED", message: "連線寫入失敗" },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelLibrary onNavigate={() => {}} />);
    const createBox = (await screen.findByRole("button", { name: "新增連線" })).closest(
      ".model-library-create",
    ) as HTMLElement;
    fireEvent.change(within(createBox).getByLabelText("連線名稱"), { target: { value: "新連線" } });
    fireEvent.change(within(createBox).getByLabelText("Base URL"), {
      target: { value: "http://localhost:9/v1" },
    });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增連線" }));

    // 就地那一份要出現……
    const inline = await waitFor(() => {
      const node = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find((element) =>
        element.textContent?.includes("連線寫入失敗"),
      );
      if (!node) throw new Error("no inline error");
      return node;
    });
    expect(inline.tagName).toBe("P");
    // ……而且只有那一份。舊版同時設頂端 toast，同一句話出現在兩個 alert region，
    // 螢幕閱讀器會連讀兩遍，而 toast 又講不出是哪一列出的問題。
    expect(document.querySelector(".toast.error")).toBeNull();
    const alerts = [...document.querySelectorAll('[role="alert"]')].filter((element) =>
      element.textContent?.includes("連線寫入失敗"),
    );
    expect(alerts).toHaveLength(1);
  });

  it("使用者一改欄位，上一次的失敗訊息就消失（不留過期訊息在旁邊）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/model-library" && !init?.method)
        return Response.json(libraryWithConnection());
      if (path.endsWith("/models") && path.startsWith("/api/model-library/connections"))
        return Response.json({ models: [] });
      return Response.json(
        { error: "COMBINATION_WRITE_FAILED", message: "組合寫入失敗" },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelLibrary onNavigate={() => {}} />);
    // rowError 掛在整個區塊的尾端（不在 `.model-library-create` 裡），所以錨點取 section。
    const section = (await screen.findByRole("button", { name: "新增組合" })).closest(
      ".model-library-section",
    ) as HTMLElement;
    // 既有組合列也有一個 aria-label 相同的輸入，所以輸入框要在建立表單裡取。
    const createBox = section.querySelector(".model-library-create") as HTMLElement;
    const nameInput = within(createBox).getByLabelText("組合名稱");
    fireEvent.change(nameInput, { target: { value: "新組合" } });
    fireEvent.click(within(createBox).getByRole("button", { name: "新增組合" }));
    await waitFor(() =>
      expect(within(section).getByText("組合寫入失敗", { exact: false })).toBeTruthy(),
    );

    fireEvent.change(nameInput, { target: { value: "新組合 2" } });
    expect(within(section).queryByText("組合寫入失敗", { exact: false })).toBeNull();
  });
});

describe("ModelLibrary 載入失敗", () => {
  it("整頁載入失敗時給得出重試，而不是只剩一顆 toast", async () => {
    let attempts = 0;
    // 路徑仍要分辨：`/connections/:id/models` 也回整份模型庫的話，連線的模型清單會變成
    // 一堆物件，之後被當成 <option> 的子節點 render 而讓整頁炸掉（測試自己的錯，不是元件的）。
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : new URL(String(input)).pathname;
      if (path.endsWith("/models") && path.startsWith("/api/model-library/connections"))
        return Response.json({ models: [] });
      attempts += 1;
      if (attempts === 1) return Response.json({ error: "BOOM" }, { status: 500 });
      return Response.json(libraryWithConnection());
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ModelLibrary onNavigate={() => {}} />);
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新載入模型庫" }));
    await waitFor(() =>
      expect(container.querySelector(".model-library-connection-row")).toBeTruthy(),
    );
  });
});
