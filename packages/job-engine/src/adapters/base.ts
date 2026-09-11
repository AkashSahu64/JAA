export interface NormalizedJob {
  source: string;
  sourceJobId?: string;
  company: string;
  title: string;
  location?: string;
  remoteType?: string;
  description: string;
  requirements: string[];
  responsibilities: string[];
  skills: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  employmentType?: string;
  seniority?: string;
  experienceMin?: number;
  experienceMax?: number;
  postedAt?: Date;
  applicationUrl: string;
  sourceUrl: string;
  companyUrl?: string;
}

export interface SearchParams {
  query?: string;
  location?: string;
  remoteType?: string[];
  experienceLevel?: string;
  employmentType?: string[];
  salary?: { min?: number; max?: number };
  skills?: string[];
  page?: number;
  pageSize?: number;
}

export abstract class JobSourceAdapter {
  abstract readonly name: string;
  abstract readonly type: string;
  
  abstract search(params: SearchParams): Promise<NormalizedJob[]>;
  abstract getJob(jobId: string): Promise<NormalizedJob | null>;
  abstract isAvailable(): Promise<boolean>;
  
  protected normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  protected normalizeCompany(company: string): string {
    return company
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+(inc|llc|ltd|corp|co|company|technologies|tech|solutions|software|services|group|international|global)$/g, '')
      .trim();
  }
  
  protected extractSkills(text: string): string[] {
    const skillPatterns = [
      /\b(JavaScript|TypeScript|Python|Java|C\+\+|C#|Ruby|Go|Rust|PHP|Swift|Kotlin|Scala|R|MATLAB)\b/gi,
      /\b(React|Angular|Vue|Next\.js|Nuxt|Svelte|Express|FastAPI|Django|Flask|Spring|Rails|Laravel|ASP\.NET)\b/gi,
      /\b(Node\.js|Deno|Bun)\b/gi,
      /\b(AWS|Azure|GCP|Google Cloud|Firebase|Heroku|Vercel|Netlify|DigitalOcean)\b/gi,
      /\b(Docker|Kubernetes|K8s|Terraform|Ansible|Jenkins|GitHub Actions|CircleCI|GitLab CI)\b/gi,
      /\b(PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|DynamoDB|Cassandra|SQLite|Oracle|SQL Server)\b/gi,
      /\b(GraphQL|REST|gRPC|WebSocket|SOAP)\b/gi,
      /\b(Git|GitHub|GitLab|Bitbucket|Jira|Confluence|Slack|Figma|Sketch)\b/gi,
      /\b(TDD|BDD|CI\/CD|Agile|Scrum|Kanban|DevOps|SRE|MLOps)\b/gi,
      /\b(HTML|CSS|SASS|SCSS|Less|Tailwind|Bootstrap|Material UI|Chakra UI)\b/gi,
      /\b(Webpack|Vite|Rollup|Parcel|esbuild|SWC)\b/gi,
      /\b(Jest|Mocha|Cypress|Playwright|Selenium|Testing Library|Vitest)\b/gi,
      /\b(Linux|Unix|Windows Server|macOS)\b/gi,
      /\b(Machine Learning|Deep Learning|NLP|Computer Vision|AI|Data Science|Big Data|ETL)\b/gi,
      /\b(Spark|Hadoop|Kafka|RabbitMQ|SQS|Celery|Airflow)\b/gi,
    ];
    
    const skills = new Set<string>();
    for (const pattern of skillPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(m => skills.add(m));
      }
    }
    return Array.from(skills);
  }
  
  protected extractExperience(text: string): { min?: number; max?: number } {
    const patterns = [
      /\b(\d+)\s*-\s*(\d+)\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience|exp)/i,
      /\b(\d+)\+?\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience|exp)/i,
      /experience\s*:?\s*(\d+)\s*-?\s*(\d+)?\s*(?:years?|yrs?)/i,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        if (match[2]) {
          return { min: parseInt(match[1]), max: parseInt(match[2]) };
        }
        return { min: parseInt(match[1]) };
      }
    }
    return {};
  }
}
