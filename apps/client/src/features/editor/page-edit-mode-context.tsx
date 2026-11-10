import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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
  isSaving: boolean;
  registerBeforeSave: (handler: () => Promise<unknown>) => () => void;
};

const PageEditModeContext = createContext<PageEditModeContextValue | null>(
  null,
);

export function PageEditModeProvider({
  children,
  initialMode = PageEditMode.Read,
  onSave,
}: React.PropsWithChildren<{
  initialMode?: PageEditMode;
  onSave?: (beforeSave: () => Promise<void>) => Promise<boolean>;
}>) {
  const [pageEditMode, setPageEditMode] = useState(initialMode);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const beforeSaveRef = useRef(new Set<() => Promise<unknown>>());
  const registerBeforeSave = useCallback((handler: () => Promise<unknown>) => {
    beforeSaveRef.current.add(handler);
    return () => {
      beforeSaveRef.current.delete(handler);
    };
  }, []);
  const savePage = useCallback(() => {
    if (!onSave) {
      setPageEditMode(PageEditMode.Read);
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    const beforeSave = async () => {
      await Promise.all([...beforeSaveRef.current].map((handler) => handler()));
    };
    void onSave(beforeSave)
      .catch(() => false)
      .then((saved) => {
        if (saved) setPageEditMode(PageEditMode.Read);
      })
      .finally(() => {
        savingRef.current = false;
        setIsSaving(false);
      });
  }, [onSave]);
  const value = useMemo(
    () => ({
      pageEditMode,
      setPageEditMode,
      savePage,
      isSaving,
      registerBeforeSave,
    }),
    [pageEditMode, savePage, isSaving, registerBeforeSave],
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
