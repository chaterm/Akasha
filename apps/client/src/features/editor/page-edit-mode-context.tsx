import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export enum PageEditMode {
  Read = "read",
  Edit = "edit",
}

type PageEditModeContextValue = {
  pageEditMode: PageEditMode;
  setPageEditMode: React.Dispatch<React.SetStateAction<PageEditMode>>;
  savePage: () => void;
};

const PageEditModeContext = createContext<PageEditModeContextValue | null>(
  null,
);

export function PageEditModeProvider({
  children,
  initialMode = PageEditMode.Read,
}: React.PropsWithChildren<{ initialMode?: PageEditMode }>) {
  const [pageEditMode, setPageEditMode] = useState(initialMode);
  const savePage = useCallback(() => {
    setPageEditMode(PageEditMode.Read);
  }, []);
  const value = useMemo(
    () => ({ pageEditMode, setPageEditMode, savePage }),
    [pageEditMode, savePage],
  );

  return (
    <PageEditModeContext.Provider value={value}>
      {children}
    </PageEditModeContext.Provider>
  );
}

export function usePageEditMode() {
  const context = useContext(PageEditModeContext);

  if (!context) {
    throw new Error("usePageEditMode must be used within PageEditModeProvider");
  }

  return context;
}
