import { JobSourceAdapter, NormalizedJob, SearchParams } from './base';

interface LeverJob {
  id: string;
  text: string;
  categories: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
  };
  description: string;
  descriptionPlain: string;
  lists: Array<{ text: string; content: string }>;
  hostedUrl: string;
  applyUrl: string;
  createdAt: number;
  updatedAt: number;
}

export class LeverAdapter extends JobSourceAdapter {
  readonly name = 'Lever';
  readonly type = 'ats';
  
  constructor(private companySlug: string) {
    super();
    if (!/^[a-z0-9_-]+$/i.test(companySlug)) {
      throw new Error('Invalid Lever company slug');
    }
  }
  
  async search(params: SearchParams): Promise<NormalizedJob[]> {
    try {
      const url = `https://api.lever.co/v0/postings/${this.companySlug}?mode=json`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Lever API error: ${response.status}`);
      
      let jobs = await response.json() as LeverJob[];
      
      if (params.query) {
        const query = params.query.toLowerCase();
        jobs = jobs.filter(j =>
          j.text.toLowerCase().includes(query) ||
          j.descriptionPlain.toLowerCase().includes(query)
        );
      }
      
      if (params.location) {
        const loc = params.location.toLowerCase();
        jobs = jobs.filter(j =>
          j.categories?.location?.toLowerCase().includes(loc)
        );
      }
      
      const page = params.page || 0;
      const pageSize = params.pageSize || 25;
      jobs = jobs.slice(page * pageSize, (page + 1) * pageSize);
      
      return jobs.map(job => this.normalize(job));
    } catch (error) {
      console.error(`Lever adapter error for ${this.companySlug}:`, error);
      return [];
    }
  }
  
  async getJob(jobId: string): Promise<NormalizedJob | null> {
    try {
      const url = `https://api.lever.co/v0/postings/${this.companySlug}/${jobId}`;
      const response = await fetch(url);
      if (!response.ok) return null;
      const job = await response.json() as LeverJob;
      return this.normalize(job);
    } catch {
      return null;
    }
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`https://api.lever.co/v0/postings/${this.companySlug}?mode=json&limit=1`);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  private normalize(job: LeverJob): NormalizedJob {
    const fullText = job.descriptionPlain + ' ' + job.lists.map(l => l.content).join(' ');
    const cleanText = this.stripHtml(fullText);
    const skills = this.extractSkills(cleanText);
    const experience = this.extractExperience(cleanText);
    
    return {
      source: 'lever',
      sourceJobId: job.id,
      company: this.companySlug,
      title: job.text,
      location: job.categories?.location,
      remoteType: this.detectRemote(job.categories?.location || '', job.categories?.commitment || ''),
      description: cleanText,
      requirements: this.extractListContent(job.lists, 'requirements'),
      responsibilities: this.extractListContent(job.lists, 'responsibilities'),
      skills,
      employmentType: this.mapCommitment(job.categories?.commitment),
      experienceMin: experience.min,
      experienceMax: experience.max,
      postedAt: new Date(job.createdAt),
      applicationUrl: job.applyUrl,
      sourceUrl: job.hostedUrl,
    };
  }
  
  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  
  private extractListContent(lists: LeverJob['lists'], keyword: string): string[] {
    const list = lists.find(l => l.text.toLowerCase().includes(keyword));
    if (!list) return [];
    return this.stripHtml(list.content)
      .split(/[•-]/)
      .map(s => s.trim())
      .filter(s => s.length > 10);
  }
  
  private detectRemote(location: string, commitment: string): string | undefined {
    const text = `${location} ${commitment}`.toLowerCase();
    if (text.includes('remote')) return 'REMOTE';
    if (text.includes('hybrid')) return 'HYBRID';
    return undefined;
  }
  
  private mapCommitment(commitment?: string): string {
    if (!commitment) return 'FULL_TIME';
    const c = commitment.toLowerCase();
    if (c.includes('full')) return 'FULL_TIME';
    if (c.includes('part')) return 'PART_TIME';
    if (c.includes('contract')) return 'CONTRACT';
    if (c.includes('intern')) return 'INTERNSHIP';
    return 'FULL_TIME';
  }
}
