import { useEffect, useState } from "react";
import { appUpdateCheck, type AppUpdate } from "../../shared/api/client";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export function useAppUpdate(): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  // #14204: keep release checks running in the v2 shell without mounting the classic shell.
  useEffect(() => {
    let alive = true;
    const check = () => appUpdateCheck().then(next => { if (alive && next) setUpdate(next); });
    void check();
    const timer = setInterval(check, CHECK_INTERVAL);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return update;
}
