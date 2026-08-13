import type { ReactNode } from "react";

interface ViewHeaderProps {
  title: string;
  description: string;
  actions?: ReactNode;
}

export function ViewHeader({
  title,
  description,
  actions,
}: ViewHeaderProps) {
  return (
    <header className="view-header">
      <div className="view-title">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </header>
  );
}
