export type NavView =
  | 'dashboard'
  | 'jobs'
  | 'resumes'
  | 'applications'
  | 'automation'
  | 'failed-apps'
  | 'analytics'
  | 'settings';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt?: string;
}

export type DiscoveryProvider = 'GREENHOUSE' | 'LEVER' | 'ASHBY';
export type DiscoveryRunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface DiscoveryRunSource {
  provider: DiscoveryProvider;
  account: string;
}

export interface DiscoveryRunSummary {
  id: string;
  automationJobId?: string;
  status: DiscoveryRunStatus;
  sources: DiscoveryRunSource[];
  query?: string;
  location?: string;
  discoveredCount: number;
  normalizedCount: number;
  duplicateCount: number;
  savedCount: number;
  failedCount: number;
  errorClass?: string;
  errorCode?: string;
  errorMessage?: string;
  errorRetryable?: boolean;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryRequest {
  greenhouseBoards: string[];
  leverCompanies: string[];
  ashbyBoards: string[];
  query?: string;
  location?: string;
}

export interface UIJob {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  remoteType?: string;
  salary: string;
  matchScore?: number;
  tier?: string;
  postedAt?: string;
  tags: string[];
  description: string;
  mustHave: string[];
  niceToHave: string[];
  redFlags: string[];
  sourceUrl?: string;
  applicationUrl?: string;
  applicationStatus?: string;
}

export interface ApplicationAttempt {
  id: string;
  attemptNumber: number;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  fieldsDetected: number;
  fieldsFilled: number;
}

export interface UIApplicationJob {
  id: string;
  type: string;
  status: string;
  availableAt: string;
  attemptCount: number;
  completedAt?: string;
  cancelledAt?: string;
  lastError?: string;
}

export interface UIInterview {
  id: string;
  date?: string;
  type: string;
  company: string;
  role: string;
  round: number;
  interviewer?: string;
  meetingUrl?: string;
  result?: string;
}

export interface OfferRecord {
  id: string;
  company: string;
  role: string;
  salaryOffered?: number;
  currency?: string;
  startDate?: string;
  expiresAt?: string;
  status: string;
}

export interface UIEmailOutcome {
  id: string;
  applicationId?: string;
  classification: string;
  confidence: string;
  receivedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  createdAt: string;
}

export interface UIEmailConnection {
  id: string;
  provider: string;
  accountLabel: string;
  scopes: string[];
  status: string;
  grantedAt?: string;
  revokedAt?: string;
  lastSyncAt?: string;
}

export interface UISearchProfile {
  id: string;
  name: string;
  schedule: string;
  isActive: boolean;
  timeZone?: string;
  maxApplicationsPerDay?: number;
  nextRunAt?: string;
  lastRunAt?: string;
}

export interface UIApplication {
  id: string;
  jobId: string;
  company: string;
  role: string;
  location?: string;
  status: string;
  version?: number;
  matchScore?: number;
  atsScore?: number;
  appliedAt?: string;
  createdAt: string;
  retryCount: number;
  failureReason?: string;
  attempts?: ApplicationAttempt[];
  interviews?: UIInterview[];
  offers?: OfferRecord[];
  emailOutcomes?: UIEmailOutcome[];
  jobs?: UIApplicationJob[];
}

export interface UIResumeVersion {
  id: string;
  resumeId: string;
  name: string;
  company?: string;
  role?: string;
  atsScore?: number;
  keywordCoverage: number;
  generatedAt: string;
  changes: string[];
  provenance: Array<{ claim: string; source: string; verified: boolean }>;
}

export interface UIResume {
  id: string;
  name: string;
  isMaster: boolean;
  fileName?: string;
  createdAt: string;
  updatedAt: string;
  pendingFactCount: number;
  versions: UIResumeVersion[];
}

export interface UICandidateFact {
  id: string;
  factType: string;
  value: unknown;
  sourceText: string;
  sourceStart?: number;
  sourceEnd?: number;
  approved: boolean;
  approvedAt?: string;
}

export interface DashboardStats {
  jobsDiscovered: number;
  qualifiedJobs: number;
  applicationsToday: number;
  applicationsThisWeek: number;
  applicationsThisMonth: number;
  interviewRate: number;
  responseRate: number;
  offerRate?: number;
  rejectionRate?: number;
  submissionSuccessRate?: number;
  averageMatchScore: number;
  averageATSScore: number;
  pendingApplications: number;
  failedApplications: number;
  lifecycleCounts?: Record<string, number>;
  providerMetrics?: Record<string, { total: number; confirmed: number; failed: number; confirmedRate: number }>;
  roleMetrics?: Record<string, { total: number; confirmed: number; failed: number; confirmedRate: number }>;
  failureReasons?: Record<string, number>;
  resumeVersionPerformance?: Record<string, { applications: number; confirmed: number; failed: number }>;
  atsScoreDistribution?: { below60: number; from60To79: number; from80To89: number; from90To100: number };
  averageTimeToConfirmationHours?: number;
  averageTimeToSubmissionHours?: number;
  interviewRounds?: { total: number; highestRound: number; byRound: Record<string, number> };
  offerOutcomes?: { total: number; byStatus: Record<string, number> };
}

export interface ApplicationFunnelRow {
  date: string;
  total: number;
  statuses: Record<string, number>;
}

export interface AutomationRun {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  stoppedAt?: string;
  jobsScanned: number;
  jobsQualified: number;
  applicationsAttempted: number;
  applicationsSubmitted: number;
  applicationsFailed: number;
  applicationsPaused: number;
}

export interface AutomationEvent {
  id?: string;
  runId?: string;
  type: string;
  message?: string;
  data?: unknown;
  timestamp: string;
}
