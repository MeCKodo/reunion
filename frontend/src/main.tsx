import "@/i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "@/components/ui/toast";
import { TaskCenterProvider } from "@/lib/task-center";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <TaskCenterProvider>
        <App />
      </TaskCenterProvider>
    </ToastProvider>
  </React.StrictMode>
);
