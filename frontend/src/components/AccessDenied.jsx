import GlassButton from "./GlassButton";

export default function AccessDenied({ pageLabel, onGoDashboard }) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="rounded-2xl border border-brand-border bg-white p-8 text-center shadow-card">
        <h1 className="text-lg font-semibold text-brand-text">Access not available for this role</h1>
        <p className="mt-3 text-sm leading-relaxed text-brand-muted">
          The &ldquo;{pageLabel}&rdquo; area is not included in your current stakeholder prototype view. Select another section
          from the sidebar or return to the dashboard.
        </p>
        <div className="mt-6 flex justify-center">
          <GlassButton type="button" variant="primary" onClick={onGoDashboard}>
            Return to Dashboard
          </GlassButton>
        </div>
      </div>
    </div>
  );
}
