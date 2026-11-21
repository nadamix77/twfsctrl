import { ControllerApp } from '@/components/controller/controller-app'

// The Tweetfess Controller panel replaces the public submit page at
// `/` (PRD-CONTROLLER §6.1 — the controller deployment is a separate
// concern from instance pages; this route is the operator surface).
// The root layout provides fonts, the theme canvas, and the Toaster;
// the app shell owns its own header — no footer (dashboard app).

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <ControllerApp />
    </div>
  )
}
