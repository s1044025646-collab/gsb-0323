export type EventType = "local" | "send" | "recv";

export interface InputEvent {
  id: string;
  participant: string;
  seq: number;
  type: EventType;
  msgId?: string;
  receiver?: string;
}

export interface ImportInput {
  participants: string[];
  events: InputEvent[];
}

export interface ClockRow {
  eventId: string;
  participant: string;
  seq: number;
  type: EventType;
  msgId: string | null;
  clock: number[];
}

export interface MessageEdge {
  msgId: string;
  sendEventId: string;
  sender: string;
  recvEventId: string | null;
  receiver: string;
}

export type ErrorCode =
  | "PARTICIPANTS_EMPTY"
  | "PARTICIPANT_DUPLICATE"
  | "EVENT_ID_DUPLICATE"
  | "EVENT_ID_EMPTY"
  | "SEQ_INVALID"
  | "SEQ_GAP"
  | "SEQ_DUPLICATE"
  | "UNKNOWN_PARTICIPANT"
  | "UNKNOWN_RECEIVER"
  | "SEND_FIELDS_MISSING"
  | "RECV_FIELDS_MISSING"
  | "LOCAL_FIELDS_FORBIDDEN"
  | "MSG_ID_DUPLICATE_SEND"
  | "SEND_NOT_FOUND"
  | "RECV_RECEIVER_MISMATCH"
  | "MSG_ALREADY_RECEIVED"
  | "CYCLE_DETECTED"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "BUILD_FAILED"
  | "SLICE_OUT_OF_RANGE"
  | "EVENT_NOT_COMPUTED";

export interface ValidationIssue {
  code: ErrorCode;
  message: string;
  eventId?: string;
  msgId?: string;
  participant?: string;
  cycle?: string[];
}

export type CausalOrder = "before" | "after" | "concurrent" | "equal";

export interface Violation {
  msgId: string;
  recvEventId: string;
  sendEventId: string;
  receiver: string;
}

export interface InFlightMessage {
  msgId: string;
  sendEventId: string;
  sender: string;
  receiver: string;
}

export interface SliceResult {
  consistent: boolean;
  prefixes: Record<string, number>;
  violations: Violation[];
  inFlight: InFlightMessage[];
  includedEvents: string[];
}

export interface BuildResult {
  datasetId: string;
  version: number;
  algoVersion: string;
  participants: string[];
  clocks: ClockRow[];
  messages: MessageEdge[];
}
