import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ProjectShell, Shell } from "./components/Shell";
import { InboxPage } from "./pages/Inbox";
import { ProjectsPage } from "./pages/Projects";
import { WorkPage } from "./pages/project/Work";
import { ArchitecturePage, InsightsPage, ModelsPage, ReviewPage, RunPage, SettingsPage } from "./pages/Static";

/** Global pages, then one project with five tabs, each with one job. */
const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <ProjectsPage /> },
      { path: "/inbox", element: <InboxPage /> },
      { path: "/models", element: <ModelsPage /> },
      { path: "/settings", element: <SettingsPage /> },
      {
        path: "/p/:project",
        element: <ProjectShell />,
        children: [
          { index: true, element: <Navigate to="work" replace /> },
          { path: "work", element: <WorkPage /> },
          { path: "review", element: <ReviewPage /> },
          { path: "run", element: <RunPage /> },
          { path: "architecture", element: <ArchitecturePage /> },
          { path: "insights", element: <InsightsPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
