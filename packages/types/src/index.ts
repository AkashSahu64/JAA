// ===== ENUMS =====

export enum ApplicationStatus {
  DISCOVERED = 'DISCOVERED',
  QUALIFIED = 'QUALIFIED',
  SKIPPED = 'SKIPPED',
  RESUME_GENERATED = 'RESUME_GENERATED',
  RESUME_VALIDATED = 'RESUME_VALIDATED',
  ATS_VALIDATED = 'ATS_VALIDATED',
  QUEUED = 'QUEUED',
  APPLICATION_STARTED = 'APPLICATION_STARTED',
  FORM_FILLED = 'FORM_FILLED',
  WAITING_FOR_USER = 'WAITING_FOR_USER',
  READY_TO_SUBMIT = 'READY_TO_SUBMIT',
  SUBMISSION_PENDING = 'SUBMISSION_PENDING',
  SUBMITTED = 'SUBMITTED',
  UNCONFIRMED = 'UNCONFIRMED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  RETRY_PENDING = 'RETRY_PENDING',
  INTERVIEW = 'INTERVIEW',
  REJECTED = 'REJECTED',
  OFFER = 'OFFER',
  ACCEPTED = 'ACCEPTED',
  WITHDRAWN = 'WITHDRAWN',
}

export enum AutomationMode {
  ASSISTED = 'ASSISTED',
  SMART_AUTO = 'SMART_AUTO',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
}

export enum AutomationStatus {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  STOPPED = 'STOPPED',
  EMERGENCY_STOPPED = 'EMERGENCY_STOPPED',
}

export enum RemoteType {
  REMOTE = 'REMOTE',
  HYBRID = 'HYBRID',
  ONSITE = 'ONSITE',
}

export enum EmploymentType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACT = 'CONTRACT',
  FREELANCE = 'FREELANCE',
  INTERNSHIP = 'INTERNSHIP',
}

export enum Seniority {
  INTERN = 'INTERN',
  JUNIOR = 'JUNIOR',
  MID = 'MID',
  SENIOR = 'SENIOR',
  LEAD = 'LEAD',
  PRINCIPAL = 'PRINCIPAL',
  STAFF = 'STAFF',
  DIRECTOR = 'DIRECTOR',
  VP = 'VP',
  C_LEVEL = 'C_LEVEL',
}

export enum JobMatchTier {
  EXCELLENT = 'EXCELLENT',
  STRONG = 'STRONG',
  MODERATE = 'MODERATE',
  WEAK = 'WEAK',
  NOT_RECOMMENDED = 'NOT_RECOMMENDED',
}

export enum QuestionRisk {
  SAFE = 'SAFE',
  PROFILE_DERIVED = 'PROFILE_DERIVED',
  SENSITIVE = 'SENSITIVE',
  HIGH_RISK = 'HIGH_RISK',
}

export enum NotificationType {
  JOB_DISCOVERED = 'JOB_DISCOVERED',
  APPLICATION_SUBMITTED = 'APPLICATION_SUBMITTED',
  APPLICATION_FAILED = 'APPLICATION_FAILED',
  CAPTCHA_REQUIRED = 'CAPTCHA_REQUIRED',
  MFA_REQUIRED = 'MFA_REQUIRED',
  USER_APPROVAL_REQUIRED = 'USER_APPROVAL_REQUIRED',
  INTERVIEW_DETECTED = 'INTERVIEW_DETECTED',
  OFFER_DETECTED = 'OFFER_DETECTED',
  DAILY_LIMIT_REACHED = 'DAILY_LIMIT_REACHED',
  AUTOMATION_STOPPED = 'AUTOMATION_STOPPED',
}

export enum SubmissionStatus {
  SUBMIT_CLICKED = 'SUBMIT_CLICKED',
  SUBMISSION_PENDING = 'SUBMISSION_PENDING',
  SUBMITTED_CONFIRMED = 'SUBMITTED_CONFIRMED',
  SUBMISSION_UNCONFIRMED = 'SUBMISSION_UNCONFIRMED',
  FAILED = 'FAILED',
}

export enum InterviewType {
  PHONE_SCREEN = 'PHONE_SCREEN',
  TECHNICAL = 'TECHNICAL',
  BEHAVIORAL = 'BEHAVIORAL',
  SYSTEM_DESIGN = 'SYSTEM_DESIGN',
  CODING = 'CODING',
  PANEL = 'PANEL',
  ONSITE = 'ONSITE',
  FINAL = 'FINAL',
  HR = 'HR',
}

// ===== INTERFACES =====

export interface SalaryRange {
  min?: number;
  max?: number;
  currency: string;
  period: 'HOURLY' | 'MONTHLY' | 'YEARLY';
}

export interface PersonalInfo {
  fullName: string;
  email: string;
  phone?: string;
  location?: LocationPreference;
  linkedIn?: string;
  github?: string;
  portfolio?: string;
  otherLinks?: Record<string, string>;
}

export interface LocationPreference {
  country: string;
  state?: string;
  city?: string;
  remotePreference: RemoteType[];
  willingToRelocate?: boolean;
}

export interface ProfessionalProfile {
  currentRole?: string;
  yearsOfExperience: number;
  targetRoles: string[];
  seniority: Seniority;
  professionalSummary?: string;
  careerObjective?: string;
}

export interface WorkExperience {
  id: string;
  company: string;
  position: string;
  startDate: string;
  endDate?: string;
  current?: boolean;
  location?: string;
  remote?: RemoteType;
  responsibilities: string[];
  achievements: string[];
  technologies: string[];
  metrics?: string[];
}

export interface Education {
  id: string;
  institution: string;
  degree: string;
  field: string;
  startDate: string;
  endDate?: string;
  gpa?: string;
  honors?: string[];
  coursework?: string[];
}

export interface Certification {
  id: string;
  name: string;
  issuer: string;
  issueDate?: string;
  expiryDate?: string;
  credentialId?: string;
  url?: string;
}

export interface SkillSet {
  programming: string[];
  frameworks: string[];
  libraries: string[];
  databases: string[];
  cloud: string[];
  devops: string[];
  tools: string[];
  softSkills: string[];
  other: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  technologies: string[];
  url?: string;
  startDate?: string;
  endDate?: string;
  highlights: string[];
}

export interface WorkAuthorization {
  authorized: boolean;
  visaRequired?: boolean;
  visaType?: string;
  sponsorshipNeeded?: boolean;
  securityClearance?: string;
}

export interface UserProfile {
  id: string;
  userId: string;
  personalInfo: PersonalInfo;
  professionalProfile: ProfessionalProfile;
  experience: WorkExperience[];
  education: Education[];
  certifications: Certification[];
  skills: SkillSet;
  projects: Project[];
  languages: Array<{ language: string; proficiency: string }>;
  workAuthorization: WorkAuthorization;
  salaryPreference?: SalaryRange;
  locationPreferences: LocationPreference[];
  noticePeriod?: string;
  availability?: string;
  additionalData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ===== JOB TYPES =====

export interface Job {
  id: string;
  source: string;
  sourceJobId?: string;
  company: string;
  title: string;
  normalizedTitle?: string;
  location?: string;
  remoteType?: RemoteType;
  description: string;
  requirements: string[];
  responsibilities: string[];
  skills: string[];
  salary?: SalaryRange;
  employmentType?: EmploymentType;
  seniority?: Seniority;
  experienceRequired?: { min?: number; max?: number };
  postedAt?: string;
  expiresAt?: string;
  applicationUrl: string;
  sourceUrl: string;
  companyUrl?: string;
  discoveredAt: string;
  fingerprint?: string;
  duplicateGroupId?: string;
  duplicateCount?: number;
  isActive: boolean;
}

export interface JobAnalysis {
  jobId: string;
  summary: string;
  mustHave: string[];
  niceToHave: string[];
  potentiallyOptional: string[];
  technologyStack: string[];
  hiddenSignals: string[];
  leadershipExpected: boolean;
  communicationLevel: string;
  domainExperience?: string;
  teamSize?: string;
  methodologies: string[];
  benefits: string[];
  redFlags: string[];
  analyzedAt: string;
}

export interface JobMatchScore {
  jobId: string;
  overall: number;
  roleMatch: number;
  skillMatch: number;
  experienceMatch: number;
  seniorityMatch: number;
  locationMatch: number;
  salaryMatch: number;
  technologyMatch: number;
  industryMatch: number;
  educationMatch: number;
  certificationMatch: number;
  workAuthorizationMatch: number;
  tier: JobMatchTier;
  matchedSkills: string[];
  missingSkills: string[];
  matchedTechnologies: string[];
  missingTechnologies: string[];
  notes: string[];
  calculatedAt: string;
}

// ===== ATS TYPES =====

export interface ATSScore {
  overall: number;
  keywordAlignment: number;
  requiredSkillCoverage: number;
  jobTitleAlignment: number;
  experienceRelevance: number;
  formattingCompatibility: number;
  sectionDetection: number;
  parsingSafety: number;
  quantifiableAchievements: number;
  readabilityScore: number;
  issues: ATSIssue[];
  recommendations: string[];
  analyzedAt: string;
}

export interface ATSIssue {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  location?: string;
  suggestion?: string;
}

// ===== RESUME TYPES =====

export interface ResumeVersion {
  id: string;
  userId: string;
  jobId?: string;
  company?: string;
  role?: string;
  jdHash?: string;
  generatedAt: string;
  atsScore?: ATSScore;
  keywordCoverage: number;
  changesFromMaster: string[];
  sourceFacts: ProvenanceRecord[];
  filePath?: string;
  content: string;
  format: 'PDF' | 'DOCX' | 'HTML';
  isMaster: boolean;
}

export interface ProvenanceRecord {
  section: string;
  claim: string;
  sourceField: string;
  sourceValue: string;
  verified: boolean;
}

export interface CoverLetter {
  id: string;
  userId: string;
  jobId: string;
  company: string;
  role: string;
  content: string;
  style: 'SHORT' | 'STANDARD' | 'HIGHLY_PERSONALIZED';
  generatedAt: string;
}

// ===== APPLICATION TYPES =====

export interface Application {
  id: string;
  userId: string;
  jobId: string;
  resumeVersionId: string;
  coverLetterId?: string;
  status: ApplicationStatus;
  submissionStatus?: SubmissionStatus;
  matchScore?: number;
  atsScore?: number;
  qualityScore?: ApplicationQualityScore;
  appliedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  failureReason?: string;
  retryCount: number;
  maxRetries: number;
  questions: ApplicationQuestionAnswer[];
  notes?: string;
  confirmationId?: string;
  automationRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationQualityScore {
  jobMatch: number;
  atsCompatibility: number;
  resumeRelevance: number;
  coverLetterQuality: number;
  profileCompleteness: number;
  applicationConfidence: number;
  overall: number;
}

export interface ApplicationQuestionAnswer {
  id: string;
  question: string;
  answer: string;
  field?: string;
  source?: string;
  confidence: number;
  riskLevel: QuestionRisk;
  validated: boolean;
  requiresHuman: boolean;
}

export interface FieldMapping {
  field: string;
  label: string;
  source: string;
  confidence: number;
  value: string;
  validated: boolean;
  type: string;
}

// ===== AUTOMATION TYPES =====

export interface AutomationRun {
  id: string;
  userId: string;
  status: AutomationStatus;
  mode: AutomationMode;
  startedAt: string;
  stoppedAt?: string;
  jobsScanned: number;
  jobsQualified: number;
  applicationsAttempted: number;
  applicationsSubmitted: number;
  applicationsFailed: number;
  applicationsPaused: number;
  errors: AutomationError[];
}

export interface AutomationError {
  jobId: string;
  error: string;
  timestamp: string;
  recoverable: boolean;
}

export interface AutomationLimits {
  maxPerDay: number;
  maxPerHour: number;
  maxPerCompanyPerDay: number;
  maxPerSourcePerDay: number;
  cooldownMs: number;
  maxRetries: number;
}

export interface AutomationEvent {
  id: string;
  runId: string;
  type: string;
  jobId?: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// ===== RULES ENGINE =====

export interface ApplicationRule {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  action: 'AUTO_APPLY' | 'SKIP' | 'REVIEW' | 'QUEUE';
  priority: number;
}

export interface RuleCondition {
  field: string;
  operator: 'gte' | 'lte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'in' | 'not_in';
  value: string | number | boolean | string[];
}

// ===== NOTIFICATION TYPES =====

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

// ===== COMPANY TYPES =====

export interface CompanyInsight {
  id: string;
  companyName: string;
  normalizedName: string;
  industry?: string;
  size?: string;
  location?: string;
  website?: string;
  careersPage?: string;
  jobCount: number;
  hiringActivity?: string;
  previouslyApplied: number;
  technologies?: string[];
  updatedAt: string;
}

// ===== INTERVIEW TYPES =====

export interface Interview {
  id: string;
  applicationId: string;
  date: string;
  type: InterviewType;
  company: string;
  role: string;
  round: number;
  interviewer?: string;
  meetingUrl?: string;
  notes?: string;
  preparationStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'READY';
  result?: 'PASSED' | 'FAILED' | 'PENDING' | 'CANCELLED';
}

// ===== ANALYTICS TYPES =====

export interface DashboardStats {
  jobsDiscovered: number;
  qualifiedJobs: number;
  applicationsToday: number;
  applicationsThisWeek: number;
  applicationsThisMonth: number;
  interviewRate: number;
  responseRate: number;
  averageMatchScore: number;
  averageATSScore: number;
  pendingApplications: number;
  failedApplications: number;
}

export interface AnalyticsData {
  applicationsOverTime: Array<{ date: string; count: number }>;
  responseRate: number;
  interviewRate: number;
  rejectionRate: number;
  matchScoreDistribution: Array<{ range: string; count: number }>;
  atsScoreDistribution: Array<{ range: string; count: number }>;
  topRoles: Array<{ role: string; applications: number; responses: number; interviews: number; rate: number }>;
  topCompanies: Array<{ company: string; applications: number; responses: number; interviews: number }>;
  sourcePerformance: Array<{ source: string; jobs: number; applications: number; responses: number }>;
}

// ===== SEARCH PROFILE =====

export interface SearchProfile {
  id: string;
  userId: string;
  name: string;
  country?: string;
  states?: string[];
  cities?: string[];
  remoteTypes: RemoteType[];
  targetRoles: string[];
  seniority?: Seniority[];
  experienceRange?: { min: number; max: number };
  skills: string[];
  technologies?: string[];
  salaryRange?: SalaryRange;
  employmentTypes: EmploymentType[];
  industries?: string[];
  excludedCompanies?: string[];
  preferredCompanies?: string[];
  sources?: string[];
  minMatchScore: number;
  minATSScore: number;
  maxApplicationsPerDay: number;
  schedule?: 'ONCE' | 'HOURLY' | 'EVERY_3_HOURS' | 'DAILY' | 'CUSTOM';
  customCron?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ===== API TYPES =====

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ===== AUDIT =====

export interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  timestamp: string;
}
