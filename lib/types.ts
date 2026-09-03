export type LeadStatus =
  | "watching"
  | "approval"
  | "waiting"
  | "interested"
  | "contacted"
  | "booked"
  | "closed"
  | "not_now"
  | "no_reply"
  | "medical_review"
  | "dnc";

export type StoppedReason =
  | "timing"
  | "availability"
  | "service"
  | "payment"
  | "requested_date"
  | "needs_time"
  | "no_response"
  | "price"
  | "competitor"
  | "not_interested"
  | "unknown";

export type ChangeType =
  | "slot"
  | "availability"
  | "service"
  | "requested_date"
  | "payment"
  | "other";

export interface Clinic {
  organization_id: string;
  clinic_name: string;
  main_service: string;
  onboarding_completed: boolean;
}

export interface Lead {
  id: string;
  organization_id: string;
  external_ref: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  service: string;
  value_minor: number;
  currency: string;
  last_contact_at: string | null;
  notes: string;
  branch: string | null;
  dnc: boolean;
  medical_escalation: boolean;
  is_demo: boolean;
  needs_fix: boolean;
  stopped_reason_code: StoppedReason;
  stopped_reason_text: string;
  preferred_time: string | null;
  requested_contact_after: string | null;
  status: LeadStatus;
  response_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessChange {
  id: string;
  organization_id: string;
  type: ChangeType;
  service: string;
  branch: string | null;
  starts_at: string | null;
  ends_at: string | null;
  title: string;
  details: string;
  is_demo: boolean;
  created_at: string;
}

export interface Recommendation {
  id: string;
  organization_id: string;
  lead_id: string;
  change_id: string;
  then_text: string;
  now_text: string;
  why_text: string;
  suggested_message: string;
  state: "review" | "dismissed" | "expired";
  expires_at: string | null;
  created_at: string;
  lead?: Lead;
  change?: BusinessChange;
}

export interface OutreachMessage {
  id: string;
  organization_id: string;
  recommendation_id: string;
  lead_id: string;
  body: string;
  status: "draft" | "copied" | "sent" | "snoozed" | "resolved";
  channel: string | null;
  copied_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Outcome {
  id: string;
  organization_id: string;
  lead_id: string;
  response_type: "interested" | "not_now" | "no_reply" | "medical_review" | "dnc" | null;
  response_text: string;
  responded_at: string | null;
  contacted_at: string | null;
  booked_at: string | null;
  closed_at: string | null;
  status: "returned" | "booked" | "closed" | "lost" | "medical_review";
  revenue_minor: number | null;
  currency: string;
  revenue_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  lead?: Lead;
}

export interface ImportLead {
  name: string;
  phone?: string;
  email?: string;
  service: string;
  value_minor?: number;
  last_contact_at?: string;
  notes?: string;
  branch?: string;
  dnc?: boolean;
  stopped_reason_code?: StoppedReason;
  stopped_reason_text?: string;
  preferred_time?: string;
  requested_contact_after?: string;
  medical_escalation?: boolean;
  needs_fix?: boolean;
  external_ref?: string;
}
