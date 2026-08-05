import React, { createContext, useContext, useMemo, useState } from "react";

export enum PageEditMode {
  Read = "read",
  Edit = "edit",
}

type PageEditModeContextValue = {
  pageEditMode: PageEditMode;
  setPageEditMode: React.Dispatch<React.SetStateAction<PageEditMode>>;
};

const PageEditModeContext = createContext<PageEditModeContextValue | null>(
  null,
);

export function PageEditModeProvider({ children }: React.PropsWithChildren) {
  const [pageEditMode, setPageEditMode] = useState(PageEditMode.Read);
  const value = useMemo(
    () => ({ pageEditMode, setPageEditMode }),
    [pageEditMode],
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
