import type { ReactNode } from "react";
import { BRAND } from "../../lib/brand";
import styles from "./app-state.module.css";

export type AppStateKind = "loading" | "empty" | "error" | "not-found";

type AppStateProps = {
  actions?: ReactNode;
  // 出错页、404 按 design/ui-copy-spec.md §8.1 只写一句，不再另加说明
  description?: string;
  kind: AppStateKind;
  // 加载中只给读屏用，界面上只有转圈（§8.1「首次加载不写字」）
  title: string;
};

function StateSymbol({ kind }: { kind: AppStateKind }) {
  if (kind === "loading") {
    return (
      <span className={styles.loadingMark} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    );
  }

  if (kind === "not-found") {
    return <span className={styles.statusCode} aria-hidden="true">404</span>;
  }

  return (
    <span className={styles.stateIcon} aria-hidden="true">
      {kind === "error" ? "!" : "—"}
    </span>
  );
}

export default function AppState({ actions, description, kind, title }: AppStateProps) {
  const isLoading = kind === "loading";
  const isError = kind === "error";

  return (
    <div className={styles.shell}>
      <section
        className={styles.panel}
        aria-live={isLoading ? "polite" : undefined}
        aria-busy={isLoading || undefined}
        role={isError ? "alert" : isLoading ? "status" : undefined}
      >
        <StateSymbol kind={kind} />
        {isLoading ? null : <p className={styles.eyebrow}>{BRAND.productName}</p>}
        <h1 className={isLoading ? "sr-only" : undefined}>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </section>
    </div>
  );
}

export { styles as appStateStyles };
