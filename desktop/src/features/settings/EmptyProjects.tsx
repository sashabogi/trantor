/** Shared empty state for the classic shell and its Hub settings. */
export function EmptyProjects({ onStart }: { onStart?: () => void }) {
  return <div className="tr-card-ghost flex items-center justify-center p-6">
    No projects yet.
    {onStart && <button type="button" className="tr-btn ml-3" onClick={onStart}>Start a project</button>}
  </div>;
}
