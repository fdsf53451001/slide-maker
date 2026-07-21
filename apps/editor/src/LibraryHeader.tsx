// 三個庫（簡報／風格庫／模型庫）共用的頂部導覽，避免各頁自己刻一份導致分頁不一致。
export type LibraryTab = "decks" | "styles" | "models";

export function LibraryHeader({
  active,
  onNavigate,
}: {
  active: LibraryTab;
  onNavigate: (path: string) => void;
}) {
  const tabs: { id: LibraryTab; label: string; path: string }[] = [
    { id: "decks", label: "簡報", path: "/" },
    { id: "styles", label: "風格庫", path: "/styles" },
    { id: "models", label: "模型庫", path: "/models" },
  ];
  return (
    <header className="dashboard-header">
      <button className="dashboard-brand" onClick={() => onNavigate("/")}>
        SM<span>↗</span>
      </button>
      <nav className="library-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={active === tab.id ? "active" : ""}
            onClick={() => onNavigate(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <span className="dashboard-local">LOCAL-FIRST · IMAGE DECKS</span>
    </header>
  );
}
