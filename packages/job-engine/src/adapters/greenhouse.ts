import { JobSourceAdapter, NormalizedJob, SearchParams } from './base';

interface GreenhouseJob {
  id: number;
  title: string;
  location: { name: string };
  content: string;
  departments: Array<{ name: string }>;
  offices: Array<{ name: string }>;
  updated_at: string;
  absolute_url: string;
  metadata?: Array<{ name: string; value: string | string[] | null }>;
}

export class GreenhouseAdapter extends JobSourceAdapter {
  readonly name = 'Greenhouse';
  readonly type = 'ats';
  
  constructor(private boardToken: string) {
    super();
    if (!/^[a-z0-9_-]+$/i.test(boardToken)) {
      throw new Error('Invalid Greenhouse board token');
    }
  }
  
  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${this.boardToken}/jobs?content=true`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Greenhouse API error: ${response.status}`);
      }
      
      const data = await response.json() as { jobs: GreenhouseJob[] };
      let jobs = data.jobs || [];
      
      // Apply filters
      if (params.query) {
        const query = params.query.toLowerCase();
        jobs = jobs.filter(j => 
          j.title.toLowerCase().includes(query) ||
          j.content.toLowerCase().includes(query)
        );
      }
      
      if (params.location) {
        const loc = params.location.toLowerCase();
        jobs = jobs.filter(j => 
          j.location?.name?.toLowerCase().includes(loc) ||
          j.offices?.some(o => o.name.toLowerCase().includes(loc))
        );
      }
      
      // Pagination
      const page = params.page || 0;
      const pageSize = params.pageSize || 25;
      const start = page * pageSize;
      jobs = jobs.slice(start, start + pageSize);
      
      return jobs.map(job => this.normalize(job));
    } catch (error) {
      console.error(`Greenhouse adapter error for ${this.boardToken}:`, error);
      return [];
    }
  }
  
  async getJob(jobId: string): Promise<NormalizedJob | null> {
    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${this.boardToken}/jobs/${jobId}?questions=true`;
      const response = await fetch(url);
      if (!response.ok) return null;
      const job = await response.json() as GreenhouseJob;
      return this.normalize(job);
    } catch {
      return null;
    }
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${this.boardToken}/jobs`);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  private normalize(job: GreenhouseJob): NormalizedJob {
    const description = this.stripHtml(job.content);
    const skills = this.extractSkills(description);
    const experience = this.extractExperience(description);
    const remoteType = this.detectRemoteType(job.location?.name || '', description);
    
    return {
      source: 'greenhouse',
      sourceJobId: String(job.id),
      company: this.boardToken, // Will be enriched later
      title: job.title,
      location: job.location?.name,
      remoteType,
      description,
      requirements: this.extractSection(description, 'requirements'),
      responsibilities: this.extractSection(description, 'responsibilities'),
      skills,
      employmentType: this.detectEmploymentType(description),
      experienceMin: experience.min,
      experienceMax: experience.max,
      postedAt: job.updated_at ? new Date(job.updated_at) : undefined,
      applicationUrl: job.absolute_url,
      sourceUrl: job.absolute_url,
    };
  }
  
  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li>/gi, '\n• ')
      .replace(/<\/?(p|div|h[1-6]|ul|ol)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  
  private extractSection(text: string, sectionName: string): string[] {
    const patterns = [
      new RegExp(`(?:${sectionName}|what you'?ll|what we'?re looking).*?(?:\n|:)([\\s\\S]*?)(?=\n\n|$)`, 'i'),
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1]
          .split('\n')
          .map(line => line.replace(/^[•\-*]\s*/, '').trim())
          .filter(line => line.length > 10);
      }
    }
    return [];
  }
  
  private detectRemoteType(location: string, description: string): string | undefined {
    const text = `${location} ${description}`.toLowerCase();
    if (text.includes('remote') && text.includes('hybrid')) return 'HYBRID';
    if (text.includes('fully remote') || text.includes('100% remote')) return 'REMOTE';
    if (text.includes('remote')) return 'REMOTE';
    if (text.includes('hybrid')) return 'HYBRID';
    if (text.includes('on-site') || text.includes('onsite') || text.includes('in-office')) return 'ONSITE';
    return undefined;
  }
  
  private detectEmploymentType(text: string): string | undefined {
    const lower = text.toLowerCase();
    if (lower.includes('full-time') || lower.includes('full time')) return 'FULL_TIME';
    if (lower.includes('part-time') || lower.includes('part time')) return 'PART_TIME';
    if (lower.includes('contract')) return 'CONTRACT';
    if (lower.includes('internship') || lower.includes('intern')) return 'INTERNSHIP';
    return 'FULL_TIME';
  }
}
