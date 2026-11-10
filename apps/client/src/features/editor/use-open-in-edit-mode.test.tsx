import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  OPEN_IN_EDIT_MODE_STATE,
  useOpenInEditModeOnce,
} from "./use-open-in-edit-mode";

let go: (to: string, state?: unknown) => void = () => {};

function Probe({ pageId }: { pageId: string }) {
  const editMode = useOpenInEditModeOnce(pageId);
  const location = useLocation();
  const navigate = useNavigate();
  go = (to, state) => navigate(to, { state });
  return (
    <div>
      <span data-testid="mode">{editMode ? "edit" : "read"}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

function renderAt(entry: { pathname: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/p/:id" element={<ProbeFromRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

function ProbeFromRoute() {
  const id = useLocation().pathname.split("/").pop()!;
  return <Probe key={id} pageId={id} />;
}

describe("useOpenInEditModeOnce", () => {
  it("带 openInEditMode 导航时进入编辑模式，并立刻清掉历史里的 state", () => {
    renderAt({ pathname: "/p/a", state: OPEN_IN_EDIT_MODE_STATE });
    expect(screen.getByTestId("mode").textContent).toBe("edit");
    // state 已被替换掉，刷新或后退回来都不会再进编辑模式
    expect(screen.getByTestId("state").textContent).toBe("null");
  });

  it("普通打开（没有 state）是阅读模式", () => {
    renderAt({ pathname: "/p/a" });
    expect(screen.getByTestId("mode").textContent).toBe("read");
  });

  it("只对请求的那个页面生效，切到别的页面后恢复阅读模式", () => {
    renderAt({ pathname: "/p/a", state: OPEN_IN_EDIT_MODE_STATE });
    expect(screen.getByTestId("mode").textContent).toBe("edit");
    act(() => go("/p/b"));
    expect(screen.getByTestId("mode").textContent).toBe("read");
  });
});
