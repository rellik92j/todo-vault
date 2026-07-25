import { useEffect, useState } from "react";

/**
 * First run. Offers the example vault when one is nearby, because otherwise the
 * first thing the app does is ask for a folder the user may not have made yet.
 */
export function Welcome({
  loading,
  error,
  onChoose,
  onOpen,
}: {
  loading: boolean;
  error: string | null;
  onChoose: () => void;
  onOpen: (root: string) => void;
}): React.JSX.Element {
  const [suggested, setSuggested] = useState<string | null>(null);

  useEffect(() => {
    void window.vault.getSuggestedVault().then((result) => {
      if (result.ok) setSuggested(result.value);
    });
  }, []);

  return (
    <div className="center">
      <div className="welcome">
        <h1>No vault open</h1>
        <p>
          A vault is an ordinary folder of markdown files. The app is a view over it — anything
          else with filesystem access can read and edit the same files.
        </p>

        {error && (
          <p style={{ color: "var(--overdue)" }}>{error}</p>
        )}

        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={onChoose} disabled={loading}>
            Choose a folder…
          </button>
          {suggested && (
            <button className="btn" onClick={() => onOpen(suggested)} disabled={loading}>
              Open the example vault
            </button>
          )}
        </div>

        {suggested && <p className="mono-path" style={{ marginTop: 14 }}>{suggested}</p>}
      </div>
    </div>
  );
}
