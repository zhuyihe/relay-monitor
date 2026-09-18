import type { ReactNode } from "react";
import { BRAND } from "../../lib/brand";
import styles from "./app-state.module.css";

export type AppStateKind = "loading" | "empty" | "error" | "not-found";

type AppStateProps = {
  actions?: ReactNode;
  description: string;
  kind: AppStateKind;
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
        <p className={styles.eyebrow}>{BRAND.productName}</p>
        <h1>{title}</h1>
        <p className={styles.description}>{description}</p>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </section>
    </div>
  );
}

export { styles as appStateStyles };
