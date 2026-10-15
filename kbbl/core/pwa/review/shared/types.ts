export interface Thread {
  id: string;
  target_type: string;
  target_id: string;
  anchor: string | null;
  author: string | null;
  status: "open" | "resolved";
  created_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  created_at: string;
}

export type ReviewMode = "review" | "edit";
