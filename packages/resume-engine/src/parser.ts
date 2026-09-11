import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { readFile } from 'fs/promises';
import path from 'path';

export interface ParsedResume {
  text: string;
  format: 'pdf' | 'docx' | 'txt';
  sections: ResumeSection[];
  metadata: {
    fileName: string;
    fileSize: number;
    parsedAt: string;
  };
}

export interface ResumeSection {
  name: string;
  content: string;
  startIndex: number;
  endIndex: number;
}

const SECTION_PATTERNS = [
  /^(professional\s*summary|summary|objective|profile|about\s*me)/im,
  /^(experience|work\s*experience|employment\s*history|professional\s*experience)/im,
  /^(education|academic\s*background|qualifications)/im,
  /^(skills|technical\s*skills|core\s*competencies|technologies)/im,
  /^(certifications?|licenses?|credentials)/im,
  /^(projects|personal\s*projects|portfolio)/im,
  /^(awards?|honors?|achievements?)/im,
  /^(publications?|research)/im,
  /^(languages?)/im,
  /^(volunteer|community|extracurricular)/im,
  /^(references?)/im,
  /^(interests?|hobbies)/im,
];

export class ResumeParser {
  async parse(filePath: string): Promise<ParsedResume> {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = await readFile(filePath);
    const stats = { size: buffer.length };
    
    let text: string;
    let format: 'pdf' | 'docx' | 'txt';
    
    switch (ext) {
      case '.pdf':
        text = await this.parsePDF(buffer);
        format = 'pdf';
        break;
      case '.docx':
        text = await this.parseDOCX(buffer);
        format = 'docx';
        break;
      case '.txt':
      case '.md':
        text = buffer.toString('utf-8');
        format = 'txt';
        break;
      default:
        throw new Error(`Unsupported file format: ${ext}`);
    }
    
    const sections = this.detectSections(text);
    
    return {
      text,
      format,
      sections,
      metadata: {
        fileName: path.basename(filePath),
        fileSize: stats.size,
        parsedAt: new Date().toISOString(),
      },
    };
  }
  
  async parseBuffer(buffer: Buffer, fileName: string): Promise<ParsedResume> {
    const ext = path.extname(fileName).toLowerCase();
    let text: string;
    let format: 'pdf' | 'docx' | 'txt';
    
    switch (ext) {
      case '.pdf':
        text = await this.parsePDF(buffer);
        format = 'pdf';
        break;
      case '.docx':
        text = await this.parseDOCX(buffer);
        format = 'docx';
        break;
      case '.txt':
      case '.md':
        text = buffer.toString('utf-8');
        format = 'txt';
        break;
      default:
        throw new Error(`Unsupported file format: ${ext}`);
    }
    
    return {
      text,
      format,
      sections: this.detectSections(text),
      metadata: {
        fileName,
        fileSize: buffer.length,
        parsedAt: new Date().toISOString(),
      },
    };
  }
  
  private async parsePDF(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text;
  }
  
  private async parseDOCX(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  
  private detectSections(text: string): ResumeSection[] {
    const lines = text.split('\n');
    const sections: ResumeSection[] = [];
    let currentSection: { name: string; startLine: number; startIndex: number } | null = null;
    let charIndex = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      for (const pattern of SECTION_PATTERNS) {
        if (pattern.test(line)) {
          // Close previous section
          if (currentSection) {
            const content = lines.slice(currentSection.startLine + 1, i).join('\n').trim();
            sections.push({
              name: currentSection.name,
              content,
              startIndex: currentSection.startIndex,
              endIndex: charIndex,
            });
          }
          
          currentSection = {
            name: line.replace(/[:\-_|]/g, '').trim(),
            startLine: i,
            startIndex: charIndex,
          };
          break;
        }
      }
      
      charIndex += lines[i].length + 1; // +1 for newline
    }
    
    // Close last section
    if (currentSection) {
      const content = lines.slice(currentSection.startLine + 1).join('\n').trim();
      sections.push({
        name: currentSection.name,
        content,
        startIndex: currentSection.startIndex,
        endIndex: text.length,
      });
    }
    
    return sections;
  }
}
