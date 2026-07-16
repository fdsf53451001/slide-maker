import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./Editor.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><Editor /></StrictMode>);

