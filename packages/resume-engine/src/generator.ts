export interface ResumeData {
  personalInfo: {
    fullName: string;
    email: string;
    phone?: string;
    location?: string;
    linkedIn?: string;
    github?: string;
    portfolio?: string;
  };
  professionalSummary?: string;
  experience: Array<{
    company: string;
    position: string;
    startDate: string;
    endDate?: string;
    current?: boolean;
    location?: string;
    bullets: string[];
  }>;
  education: Array<{
    institution: string;
    degree: string;
    field: string;
    startDate: string;
    endDate?: string;
    gpa?: string;
  }>;
  skills: {
    categories: Array<{
      name: string;
      items: string[];
    }>;
  };
  certifications?: Array<{
    name: string;
    issuer: string;
    date?: string;
  }>;
  projects?: Array<{
    name: string;
    description: string;
    technologies: string[];
    url?: string;
  }>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? escapeHtml(url.href) : null;
  } catch {
    return null;
  }
}

export class ResumeGenerator {
  generateHTML(data: ResumeData): string {
    const e = escapeHtml;
    const linkedIn = data.personalInfo.linkedIn ? safeLink(data.personalInfo.linkedIn) : null;
    const github = data.personalInfo.github ? safeLink(data.personalInfo.github) : null;
    const portfolio = data.personalInfo.portfolio ? safeLink(data.personalInfo.portfolio) : null;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${e(data.personalInfo.fullName)} - Resume</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Calibri', 'Helvetica Neue', Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.4;
      color: #333;
      max-width: 8.5in;
      margin: 0 auto;
      padding: 0.5in 0.6in;
    }
    h1 { font-size: 18pt; color: #1a1a1a; margin-bottom: 4px; }
    h2 {
      font-size: 12pt;
      color: #1a1a1a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1.5px solid #333;
      padding-bottom: 2px;
      margin-top: 12px;
      margin-bottom: 6px;
    }
    h3 { font-size: 11pt; font-weight: 600; }
    .contact-info {
      font-size: 10pt;
      color: #555;
      margin-bottom: 8px;
    }
    .contact-info a { color: #555; text-decoration: none; }
    .contact-info span { margin: 0 6px; }
    .experience-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 2px;
    }
    .experience-header .dates {
      font-size: 10pt;
      color: #666;
      white-space: nowrap;
    }
    .company-line {
      font-style: italic;
      color: #555;
      margin-bottom: 4px;
    }
    ul {
      list-style: disc;
      padding-left: 18px;
      margin-bottom: 6px;
    }
    li { margin-bottom: 2px; }
    .skills-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 12px;
    }
    .skill-category { font-weight: 600; }
    .summary { margin-bottom: 4px; }
    .project-tech { font-size: 10pt; color: #666; }
    @media print {
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${e(data.personalInfo.fullName)}</h1>
    <div class="contact-info">
      ${e(data.personalInfo.email)}
      ${data.personalInfo.phone ? `<span>|</span>${e(data.personalInfo.phone)}` : ''}
      ${data.personalInfo.location ? `<span>|</span>${e(data.personalInfo.location)}` : ''}
      ${linkedIn ? `<span>|</span><a href="${linkedIn}">LinkedIn</a>` : ''}
      ${github ? `<span>|</span><a href="${github}">GitHub</a>` : ''}
      ${portfolio ? `<span>|</span><a href="${portfolio}">Portfolio</a>` : ''}
    </div>
  </header>

  ${data.professionalSummary ? `
  <section>
    <h2>Professional Summary</h2>
    <p class="summary">${e(data.professionalSummary)}</p>
  </section>` : ''}

  ${data.experience.length > 0 ? `
  <section>
    <h2>Experience</h2>
    ${data.experience.map(exp => `
    <div style="margin-bottom: 8px;">
      <div class="experience-header">
        <h3>${e(exp.position)}</h3>
        <span class="dates">${e(exp.startDate)} – ${exp.current ? 'Present' : e(exp.endDate || '')}</span>
      </div>
      <div class="company-line">${e(exp.company)}${exp.location ? ` | ${e(exp.location)}` : ''}</div>
      ${exp.bullets.length > 0 ? `
      <ul>
        ${exp.bullets.map(b => `<li>${e(b)}</li>`).join('\n        ')}
      </ul>` : ''}
    </div>`).join('')}
  </section>` : ''}

  ${data.education.length > 0 ? `
  <section>
    <h2>Education</h2>
    ${data.education.map(edu => `
    <div style="margin-bottom: 6px;">
      <div class="experience-header">
        <h3>${e(edu.degree)} in ${e(edu.field)}</h3>
        <span class="dates">${e(edu.startDate)} – ${e(edu.endDate || 'Present')}</span>
      </div>
      <div class="company-line">${e(edu.institution)}${edu.gpa ? ` | GPA: ${e(edu.gpa)}` : ''}</div>
    </div>`).join('')}
  </section>` : ''}

  ${data.skills.categories.length > 0 ? `
  <section>
    <h2>Technical Skills</h2>
    <div class="skills-grid">
      ${data.skills.categories.map(cat => `
      <span class="skill-category">${e(cat.name)}:</span>
      <span>${cat.items.map(e).join(', ')}</span>`).join('')}
    </div>
  </section>` : ''}

  ${data.certifications && data.certifications.length > 0 ? `
  <section>
    <h2>Certifications</h2>
    <ul>
      ${data.certifications.map(c => `<li><strong>${e(c.name)}</strong> – ${e(c.issuer)}${c.date ? ` (${e(c.date)})` : ''}</li>`).join('\n      ')}
    </ul>
  </section>` : ''}

  ${data.projects && data.projects.length > 0 ? `
  <section>
    <h2>Projects</h2>
    ${data.projects.map(p => `
    <div style="margin-bottom: 6px;">
      <h3>${e(p.name)}${p.url && safeLink(p.url) ? ` <a href="${safeLink(p.url)}" style="font-weight:normal;font-size:10pt;">[Link]</a>` : ''}</h3>
      <p>${e(p.description)}</p>
      <p class="project-tech">Technologies: ${p.technologies.map(e).join(', ')}</p>
    </div>`).join('')}
  </section>` : ''}
</body>
</html>`;
  }

  generatePlainText(data: ResumeData): string {
    let text = '';
    
    text += `${data.personalInfo.fullName}\n`;
    text += `${data.personalInfo.email}`;
    if (data.personalInfo.phone) text += ` | ${data.personalInfo.phone}`;
    if (data.personalInfo.location) text += ` | ${data.personalInfo.location}`;
    if (data.personalInfo.linkedIn) text += ` | ${data.personalInfo.linkedIn}`;
    if (data.personalInfo.github) text += ` | ${data.personalInfo.github}`;
    text += '\n\n';
    
    if (data.professionalSummary) {
      text += `PROFESSIONAL SUMMARY\n${'='.repeat(40)}\n${data.professionalSummary}\n\n`;
    }
    
    if (data.experience.length > 0) {
      text += `EXPERIENCE\n${'='.repeat(40)}\n`;
      for (const exp of data.experience) {
        text += `${exp.position}\n`;
        text += `${exp.company} | ${exp.startDate} – ${exp.current ? 'Present' : exp.endDate || ''}\n`;
        for (const bullet of exp.bullets) {
          text += `• ${bullet}\n`;
        }
        text += '\n';
      }
    }
    
    if (data.education.length > 0) {
      text += `EDUCATION\n${'='.repeat(40)}\n`;
      for (const edu of data.education) {
        text += `${edu.degree} in ${edu.field}\n`;
        text += `${edu.institution} | ${edu.startDate} – ${edu.endDate || 'Present'}\n`;
        if (edu.gpa) text += `GPA: ${edu.gpa}\n`;
        text += '\n';
      }
    }
    
    if (data.skills.categories.length > 0) {
      text += `SKILLS\n${'='.repeat(40)}\n`;
      for (const cat of data.skills.categories) {
        text += `${cat.name}: ${cat.items.join(', ')}\n`;
      }
      text += '\n';
    }
    
    if (data.certifications && data.certifications.length > 0) {
      text += `CERTIFICATIONS\n${'='.repeat(40)}\n`;
      for (const c of data.certifications) {
        text += `• ${c.name} – ${c.issuer}${c.date ? ` (${c.date})` : ''}\n`;
      }
      text += '\n';
    }
    
    if (data.projects && data.projects.length > 0) {
      text += `PROJECTS\n${'='.repeat(40)}\n`;
      for (const p of data.projects) {
        text += `${p.name}\n${p.description}\nTech: ${p.technologies.join(', ')}\n\n`;
      }
    }
    
    return text;
  }
}
