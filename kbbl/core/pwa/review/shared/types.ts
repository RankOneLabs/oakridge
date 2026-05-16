export interface AtomEdit {
  id: string;
  target_type: string;
  target_id: string;
  anchor: string | null;
  prior_value: string | null;
  new_value: string;
  author: string;
  created_at: string;
}

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
