const fs = require('fs');
const path = require('path');

const filepath = path.join(__dirname, '../../Frontend/app/src/services/templateService.js');
let content = fs.readFileSync(filepath, 'utf8');

const targetKeyword = 'const renderModernATSTemplate = (resume, styles = {}) => {';
const startIndex = content.indexOf(targetKeyword);

if (startIndex === -1) {
  console.error('Could not find target keyword!');
  process.exit(1);
}

const beforePart = content.substring(0, startIndex);

const newTemplatesCode = `const renderModernATSTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages, targetJob } = resume;

  const font = styles.font || 'Inter';
  const accent = styles.accentColor || '#1E3A8A';
  const heading = styles.headingColor || '#0F172A';
  const text = styles.textColor || '#334155';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Outfit:wght@300;400;500;600;700&family=Playfair+Display:wght@400;600;700&family=Open+Sans:wght@300;400;600;700&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: '\${font}', 'Inter', sans-serif; background: \${bg}; color: \${text}; padding: 30px; line-height: 1.5; font-size: 13px; }
        .header { margin-bottom: 20px; border-bottom: 2px solid \${accent}; padding-bottom: 12px; }
        .name { font-size: 26px; font-weight: 800; color: \${heading}; letter-spacing: -0.5px; }
        .title { font-size: 14px; font-weight: 600; color: \${accent}; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
        .contact { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: \${text}; opacity: 0.85; margin-top: 8px; }
        .contact span, .contact a { display: inline-flex; align-items: center; color: inherit; text-decoration: none; }
        .contact a:hover { text-decoration: underline; color: \${accent}; }
        .section { margin-bottom: 20px; }
        .section-title { font-size: 14px; font-weight: 700; color: \${accent}; text-transform: uppercase; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; margin-bottom: 12px; letter-spacing: 0.5px; }
        .item { margin-bottom: 14px; }
        .item-header { display: flex; justify-content: space-between; align-items: baseline; font-weight: 700; color: \${heading}; font-size: 13.5px; }
        .item-subheader { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: \${text}; opacity: 0.85; margin: 2px 0 6px 0; }
        .item-desc { font-size: 12.5px; color: \${text}; line-height: 1.55; white-space: pre-wrap; margin-top: 4px; padding-left: 10px; border-left: 2px solid #E2E8F0; }
        .bullet-list { margin-top: 6px; padding-left: 20px; list-style-type: disc; }
        .bullet-item { font-size: 12.5px; margin-bottom: 2px; color: \${text}; text-align: justify; }
        .skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
        .skill-badge { background: #F1F5F9; color: \${heading}; padding: 4px 10px; border-radius: 4px; font-size: 11.5px; font-weight: 500; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
        <div class="title">\${personalInfo?.title || targetJob?.jobTitle || ''}</div>
        <div class="contact">
          \${personalInfo?.email ? \`<a href="mailto:\${personalInfo.email}">✉ \${personalInfo.email}</a>\` : ''}
          \${personalInfo?.phone ? \`<a href="tel:\${personalInfo.phone}">📞 \${personalInfo.phone}</a>\` : ''}
          \${personalInfo?.location ? \`<span>📍 \${personalInfo.location}</span>\` : ''}
          \${personalInfo?.linkedin ? \`<a href="https://linkedin.com/in/\${personalInfo.linkedin.replace('https://', '').replace('linkedin.com/in/', '')}" target="_blank">in/ \${personalInfo.linkedin.replace('https://', '').replace('linkedin.com/in/', '')}</a>\` : ''}
          \${personalInfo?.github ? \`<a href="https://github.com/\${personalInfo.github.replace('https://', '').replace('github.com/', '')}" target="_blank">github/ \${personalInfo.github.replace('https://', '').replace('github.com/', '')}</a>\` : ''}
        </div>
      </div>

      \${professionalSummary?.summary ? \`
      <div class="section">
        <div class="section-title">Professional Summary</div>
        <p style="text-align: justify; line-height: 1.6; font-size: 12.5px;">\${professionalSummary.summary}</p>
      </div>\` : ''}

      \${workExperience && workExperience.length > 0 ? \`
      <div class="section">
        <div class="section-title">Experience</div>
        \${workExperience.map(work => \`
          <div class="item">
            <div class="item-header">
              <span>\${work.position}</span>
              <span style="font-weight: 500; font-size: 12px; color: \${text};">\${formatDateRange(work.startDate, work.endDate, work.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${work.company}</span>
              <span style="font-style: italic;">\${work.location || ''}</span>
            </div>
            \${work.description ? \`<div class="item-desc">\${work.description}</div>\` : ''}
            \${work.achievements && work.achievements.length > 0 ? \`
              <ul class="bullet-list">
                \${work.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
              </ul>
            \` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${education && education.length > 0 ? \`
      <div class="section">
        <div class="section-title">Education</div>
        \${education.map(edu => \`
          <div class="item">
            <div class="item-header">
              <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
              <span style="font-weight: 500; font-size: 12px; color: \${text};">\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${edu.institution}</span>
              \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
            </div>
            \${edu.description ? \`<div class="item-desc" style="border-left:none; padding-left:0;">\${edu.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${projects && projects.length > 0 ? \`
      <div class="section">
        <div class="section-title">Projects</div>
        \${projects.map(proj => \`
          <div class="item">
            <div class="item-header">
              <span>\${proj.name}</span>
              <span style="font-weight: 500; font-size: 11.5px; color: \${accent};">\${Array.isArray(proj.technologies) ? proj.technologies.slice(0, 5).join(', ') : (proj.technologies || '')}</span>
            </div>
            \${proj.url ? \`<div class="item-subheader"><span>Link: \${proj.url}</span></div>\` : ''}
            \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${skills && skills.length > 0 ? \`
      <div class="section">
        <div class="section-title">Skills</div>
        <div class="skills-grid">
          \${skills.map(s => \`<span class="skill-badge">\${s.name}</span>\`).join('')}
        </div>
      </div>\` : ''}

      \${certifications && certifications.length > 0 ? \`
      <div class="section">
        <div class="section-title">Certifications</div>
        \${certifications.map(cert => \`
          <div class="item" style="margin-bottom: 6px;">
            <div class="item-header" style="font-size: 12.5px;">
              <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
              <span style="font-weight: 500; font-size: 12px; color: \${text};">\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${languages && languages.length > 0 ? \`
      <div class="section">
        <div class="section-title">Languages</div>
        <div style="font-size: 12.5px;">
          \${languages.map(l => \`<strong>\${l.name}</strong> (\${l.proficiency || 'Intermediate'})\`).join('  |  ')}
        </div>
      </div>\` : ''}
    </body>
    </html>
  \`;
};

const renderStanfordTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Georgia';
  const accent = styles.accentColor || '#4B5563';
  const heading = styles.headingColor || '#111827';
  const text = styles.textColor || '#000000';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', Georgia, serif; background: \${bg}; color: \${text}; margin: 30px; line-height: 1.4; font-size: 12px; }
        .name { text-align: center; font-size: 22px; font-weight: bold; text-transform: uppercase; margin-bottom: 2px; color: \${heading}; }
        .contact { text-align: center; font-size: 11px; margin-bottom: 15px; border-bottom: 1.5px double \${accent}; padding-bottom: 8px; color: \${text}; opacity: 0.85; }
        .section { margin-bottom: 14px; }
        .section-title { font-size: 12px; font-weight: bold; text-transform: uppercase; border-bottom: 1px solid \${accent}; padding-bottom: 2px; margin-bottom: 6px; letter-spacing: 0.5px; color: \${heading}; }
        .item { margin-bottom: 10px; }
        .item-row { display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; color: \${heading}; }
        .item-subrow { display: flex; justify-content: space-between; font-size: 11.5px; font-style: italic; margin-top: 1px; color: \${text}; opacity: 0.85; }
        .item-desc { font-size: 11.5px; text-align: justify; margin-top: 4px; padding-left: 8px; color: \${text}; }
        .bullet-list { margin-top: 4px; padding-left: 20px; list-style-type: disc; }
        .bullet-item { font-size: 11.5px; margin-bottom: 2px; text-align: justify; color: \${text}; }
      </style>
    </head>
    <body>
      <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
      <div class="contact">
        \${personalInfo?.email || ''} | \${personalInfo?.phone || ''} | \${personalInfo?.location || ''}
        \${personalInfo?.linkedin ? \` | linkedin.com/in/\${personalInfo.linkedin}\` : ''}
        \${personalInfo?.github ? \` | github.com/\${personalInfo.github}\` : ''}
      </div>

      \${professionalSummary?.summary ? \`
      <div class="section">
        <div class="section-title">Professional Summary</div>
        <p style="text-align: justify; font-size: 11.5px;">\${professionalSummary.summary}</p>
      </div>\` : ''}

      \${workExperience && workExperience.length > 0 ? \`
      <div class="section">
        <div class="section-title">Experience</div>
        \${workExperience.map(work => \`
          <div class="item">
            <div class="item-row">
              <span>\${work.position}</span>
              <span>\${formatDateRange(work.startDate, work.endDate, work.current)}</span>
            </div>
            <div class="item-subrow">
              <span>\${work.company}</span>
              <span>\${work.location || ''}</span>
            </div>
            \${work.description ? \`<div class="item-desc">\${work.description}</div>\` : ''}
            \${work.achievements && work.achievements.length > 0 ? \`
              <ul class="bullet-list">
                \${work.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
              </ul>
            \` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${education && education.length > 0 ? \`
      <div class="section">
        <div class="section-title">Education</div>
        \${education.map(edu => \`
          <div class="item">
            <div class="item-row">
              <span>\${edu.institution}</span>
              <span>\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
            </div>
            <div class="item-subrow">
              <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
              \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
            </div>
            \${edu.description ? \`<div class="item-desc">\text: \${edu.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${projects && projects.length > 0 ? \`
      <div class="section">
        <div class="section-title">Projects</div>
        \${projects.map(proj => \`
          <div class="item">
            <div class="item-row">
              <span>\${proj.name}</span>
              <span>\${formatDateRange(proj.startDate, proj.endDate, false)}</span>
            </div>
            <div class="item-subrow">
              <span>\${Array.isArray(proj.technologies) ? proj.technologies.join(', ') : (proj.technologies || '')}</span>
              \${proj.url ? \`<span>\${proj.url}</span>\` : ''}
            </div>
            \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${skills && skills.length > 0 ? \`
      <div class="section">
        <div class="section-title">Skills</div>
        <p style="font-size: 11.5px;">\${skills.map(s => s.name).join(', ')}</p>
      </div>\` : ''}

      \${certifications && certifications.length > 0 ? \`
      <div class="section">
        <div class="section-title">Certifications</div>
        \${certifications.map(cert => \`
          <div class="item" style="margin-bottom: 4px;">
            <div class="item-row">
              <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
              <span>\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${languages && languages.length > 0 ? \`
      <div class="section">
        <div class="section-title">Languages</div>
        <p style="font-size: 11.5px;">
          \${languages.map(l => \`\${l.name} (\${l.proficiency || 'Intermediate'})\`).join(' | ')}
        </p>
      </div>\` : ''}
    </body>
    </html>
  \`;
};

const renderFAANGTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Helvetica';
  const accent = styles.accentColor || '#111827';
  const heading = styles.headingColor || '#111827';
  const text = styles.textColor || '#334155';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', Helvetica, Arial, sans-serif; background: \address: \${bg}; margin: 24px; line-height: 1.45; color: \${text}; font-size: 12.5px; }
        .header { text-align: center; margin-bottom: 16px; }
        .name { font-size: 22px; font-weight: bold; color: \${heading}; margin-bottom: 2px; }
        .contact { font-size: 11.5px; color: \${text}; opacity: 0.85; }
        .section { margin-bottom: 14px; }
        .section-title { font-size: 12px; font-weight: bold; border-bottom: 1.5px solid \${accent}; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; color: \${heading}; }
        .item { margin-bottom: 8px; }
        .item-header { display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; color: \${heading}; }
        .item-subheader { display: flex; justify-content: space-between; font-size: 11.5px; font-style: italic; margin-top: 1px; color: \${text}; }
        .item-desc { font-size: 11.5px; margin-top: 2px; line-height: 1.5; color: \${text}; }
        .bullet-list { margin-top: 4px; padding-left: 20px; list-style-type: disc; }
        .bullet-item { font-size: 11.5px; margin-bottom: 2px; text-align: justify; color: \${text}; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
        <div class="contact">
          \${personalInfo?.email || ''} | \${personalInfo?.phone || ''} | \${personalInfo?.location || ''}
          \${personalInfo?.linkedin ? \` | linkedin: \${personalInfo.linkedin}\` : ''}
          \${personalInfo?.github ? \` | github: \${personalInfo.github}\` : ''}
        </div>
      </div>

      \${professionalSummary?.summary ? \`
      <div class="section">
        <div class="section-title">Professional Summary</div>
        <p style="text-align: justify; line-height: 1.5;">\${professionalSummary.summary}</p>
      </div>\` : ''}

      \${workExperience && workExperience.length > 0 ? \`
      <div class="section">
        <div class="section-title">Experience</div>
        \${workExperience.map(work => \`
          <div class="item">
            <div class="item-header">
              <span>\${work.position}</span>
              <span>\${formatDateRange(work.startDate, work.endDate, work.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${work.company}</span>
              <span>\${work.location || ''}</span>
            </div>
            \${work.description ? \`<div class="item-desc">\${work.description}</div>\` : ''}
            \${work.achievements && work.achievements.length > 0 ? \`
              <ul class="bullet-list">
                \${work.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
              </ul>
            \` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${education && education.length > 0 ? \`
      <div class="section">
        <div class="section-title">Education</div>
        \${education.map(edu => \`
          <div class="item">
            <div class="item-header">
              <span>\${edu.institution}</span>
              <span>\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${edu.degree} \text: \${edu.fieldOfStudy || ''}</span>
              \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
            </div>
            \${edu.description ? \`<div class="item-desc">\${edu.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${projects && projects.length > 0 ? \`
      <div class="section">
        <div class="section-title">Projects</div>
        \${projects.map(proj => \`
          <div class="item">
            <div class="item-header">
              <span>\${proj.name}</span>
              <span>\${formatDateRange(proj.startDate, proj.endDate, false)}</span>
            </div>
            <div class="item-subheader">
              <span>\${Array.isArray(proj.technologies) ? proj.technologies.join(', ') : (proj.technologies || '')}</span>
              \${proj.url ? \`<span>\${proj.url}</span>\` : ''}
            </div>
            \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${skills && skills.length > 0 ? \`
      <div class="section">
        <div class="section-title">Skills</div>
        <div style="font-size: 12px; color: \${text};">
          \${skills.map(s => s.name).join(', ')}
        </div>
      </div>\` : ''}

      \${certifications && certifications.length > 0 ? \`
      <div class="section">
        <div class="section-title">Certifications</div>
        \${certifications.map(cert => \`
          <div class="item" style="margin-bottom: 4px;">
            <div class="item-header">
              <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
              <span>\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${languages && languages.length > 0 ? \`
      <div class="section">
        <div class="section-title">Languages</div>
        <div style="font-size: 12px; color: \${text};">
          \${languages.map(l => \`\${l.name} (\${l.proficiency || 'Intermediate'})\`).join(' | ')}
        </div>
      </div>\` : ''}
    </body>
    </html>
  \`;
};

const renderJakesTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Garamond';
  const accent = styles.accentColor || '#000000';
  const heading = styles.headingColor || '#000000';
  const text = styles.textColor || '#000000';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', Garamond, Georgia, serif; background: \${bg}; margin: 25px; line-height: 1.4; color: \${text}; font-size: 12px; }
        .header { text-align: center; margin-bottom: 12px; }
        .name { font-size: 24px; font-weight: bold; margin-bottom: 2px; color: \${heading}; text-transform: uppercase; }
        .contact { font-size: 11px; color: \${text}; opacity: 0.9; }
        .section { margin-bottom: 12px; }
        .section-title { font-size: 12.5px; font-weight: bold; border-bottom: 1px solid \${accent}; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.5px; color: \${heading}; }
        .item { margin-bottom: 8px; }
        .item-row { display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; color: \${heading}; }
        .item-subrow { display: flex; justify-content: space-between; font-size: 11px; font-style: italic; color: \${text}; opacity: 0.9; }
        .item-desc { font-size: 11.5px; text-align: justify; margin-top: 2px; color: \${text}; }
        .bullet-list { margin-top: 4px; padding-left: 20px; list-style-type: disc; }
        .bullet-item { font-size: 11.5px; margin-bottom: 2px; text-align: justify; color: \${text}; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
        <div class="contact">
          \text: \${personalInfo?.phone || ''} | \${personalInfo?.email || ''} | \${personalInfo?.location || ''}
          \${personalInfo?.linkedin ? \` | linkedin.com/in/\${personalInfo.linkedin}\` : ''}
          \${personalInfo?.github ? \` | github.com/\${personalInfo.github}\` : ''}
        </div>
      </div>

      \${professionalSummary?.summary ? \`
      <div class="section">
        <div class="section-title">Summary</div>
        <p style="text-align: justify; font-size: 11.5px; line-height: 1.45;">\${professionalSummary.summary}</p>
      </div>\` : ''}

      \${workExperience && workExperience.length > 0 ? \`
      <div class="section">
        <div class="section-title">Experience</div>
        \${workExperience.map(work => \`
          <div class="item">
            <div class="item-row">
              <span>\${work.position}</span>
              <span>\${formatDateRange(work.startDate, work.endDate, work.current)}</span>
            </div>
            <div class="item-subrow">
              <span>\${work.company}</span>
              <span>\${work.location || ''}</span>
            </div>
            \${work.description ? \`<div class="item-desc">\${work.description}</div>\` : ''}
            \${work.achievements && work.achievements.length > 0 ? \`
              <ul class="bullet-list">
                \${work.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
              </ul>
            \` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${education && education.length > 0 ? \`
      <div class="section">
        <div class="section-title">Education</div>
        \${education.map(edu => \`
          <div class="item">
            <div class="item-row">
              <span>\${edu.institution}</span>
              <span>\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
            </div>
            <div class="item-subrow">
              <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
              \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${projects && projects.length > 0 ? \`
      <div class="section">
        <div class="section-title">Projects</div>
        \${projects.map(proj => \`
          <div class="item">
            <div class="item-row">
              <span>\${proj.name}</span>
              <span>\${formatDateRange(proj.startDate, proj.endDate, false)}</span>
            </div>
            <div class="item-subrow">
              <span>\${Array.isArray(proj.technologies) ? proj.technologies.join(', ') : (proj.technologies || '')}</span>
              \${proj.url ? \`<span>\${proj.url}</span>\` : ''}
            </div>
            \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${skills && skills.length > 0 ? \`
      <div class="section">
        <div class="section-title">Skills</div>
        <p style="font-size: 11.5px; line-height: 1.4;">
          \${skills.map(s => s.name).join(', ')}
        </p>
      </div>\` : ''}

      \${certifications && certifications.length > 0 ? \`
      <div class="section">
        <div class="section-title">Certifications</div>
        \${certifications.map(cert => \`
          <div class="item" style="margin-bottom: 4px;">
            <div class="item-row">
              <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
              <span>\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${languages && languages.length > 0 ? \`
      <div class="section">
        <div class="section-title">Languages</div>
        <p style="font-size: 11.5px;">
          \${languages.map(l => \`\${l.name} (\${l.proficiency || 'Intermediate'})\`).join(' | ')}
        </p>
      </div>\` : ''}
    </body>
    </html>
  \`;
};

const renderReziTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Roboto';
  const accent = styles.accentColor || '#111827';
  const heading = styles.headingColor || '#111827';
  const text = styles.textColor || '#1F2937';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', Roboto, sans-serif; background: \${bg}; margin: 30px; color: \${text}; font-size: 12.5px; line-height: 1.5; }
        .header { text-align: left; margin-bottom: 20px; border-left: 4px solid \${accent}; padding-left: 12px; }
        .name { font-size: 24px; font-weight: bold; text-transform: uppercase; color: \${heading}; letter-spacing: -0.5px; }
        .contact { font-size: 11.5px; color: \${text}; opacity: 0.85; margin-top: 4px; }
        .section { margin-bottom: 18px; }
        .section-title { font-size: 13.5px; font-weight: bold; border-bottom: 2px solid \${accent}; padding-bottom: 2px; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; color: \${heading}; }
        .item { margin-bottom: 10px; }
        .item-header { display: flex; justify-content: space-between; font-weight: bold; color: \${heading}; font-size: 13px; }
        .item-subheader { display: flex; justify-content: space-between; font-size: 11.5px; font-style: italic; margin-top: 1px; color: \${text}; }
        .item-desc { font-size: 12px; color: \${text}; margin-top: 4px; line-height: 1.45; }
        .bullet-list { margin-top: 4px; padding-left: 20px; list-style-type: square; }
        .bullet-item { font-size: 12px; margin-bottom: 2px; text-align: justify; color: \${text}; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
        <div class="contact">
          \${personalInfo?.email || ''} | \${personalInfo?.phone || ''} | \${personalInfo?.location || ''}
          \${personalInfo?.linkedin ? \` | linkedin.com/in/\${personalInfo.linkedin}\` : ''}
          \${personalInfo?.github ? \` | github.com/\${personalInfo.github}\` : ''}
        </div>
      </div>

      \${professionalSummary?.summary ? \`
      <div class="section">
        <div class="section-title">Professional Summary</div>
        <p style="text-align: justify; font-size: 12px;">\${professionalSummary.summary}</p>
      </div>\` : ''}

      \${workExperience && workExperience.length > 0 ? \`
      <div class="section">
        <div class="section-title">Work Experience</div>
        \${workExperience.map(w => \`
          <div class="item">
            <div class="item-header">
              <span>\${w.position} @ \${w.company}</span>
              <span>\text: \${formatDateRange(w.startDate, w.endDate, w.current)}</span>
            </div>
            \${w.description ? \`<div class="item-desc">\${w.description}</div>\` : ''}
            \${w.achievements && w.achievements.length > 0 ? \`
              <ul class="bullet-list">
                \${w.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
              </ul>
            \` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${education && education.length > 0 ? \`
      <div class="section">
        <div class="section-title">Education</div>
        \${education.map(edu => \`
          <div class="item">
            <div class="item-header">
              <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
              <span>\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${edu.institution}</span>
              \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${projects && projects.length > 0 ? \`
      <div class="section">
        <div class="section-title">Projects</div>
        \${projects.map(proj => \`
          <div class="item">
            <div class="item-header">
              <span>\${proj.name}</span>
              <span>\${formatDateRange(proj.startDate, proj.endDate, false)}</span>
            </div>
            \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${skills && skills.length > 0 ? \`
      <div class="section">
        <div class="section-title">Skills & Core Competencies</div>
        <p style="font-size: 12px;">\${skills.map(s => s.name).join(', ')}</p>
      </div>\` : ''}

      \${certifications && certifications.length > 0 ? \`
      <div class="section">
        <div class="section-title">Certifications</div>
        \${certifications.map(cert => \`
          <div class="item" style="margin-bottom: 4px;">
            <div class="item-header">
              <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
              <span>\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${languages && languages.length > 0 ? \`
      <div class="section">
        <div class="section-title">Languages</div>
        <p style="font-size: 12px;">
          \${languages.map(l => \`\${l.name} (\text: \${l.proficiency || 'Intermediate'})\`).join(' | ')}
        </p>
      </div>\` : ''}
    </body>
    </html>
  \`;
};

const renderFlowCVTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Outfit';
  const accent = styles.accentColor || '#3B82F6';
  const bg = styles.bgColor || '#F8FAFC';
  const text = styles.textColor || '#2D3748';
  const heading = styles.headingColor || '#1E293B';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', 'Outfit', sans-serif; background: \${bg}; padding: 30px; color: \${text}; font-size: 13px; line-height: 1.6; }
        .card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #E2E8F0; }
        .header { border-bottom: 2px solid #E2E8F0; padding-bottom: 16px; margin-bottom: 20px; }
        .name { font-size: 28px; font-weight: 800; color: \${heading}; }
        .title { font-size: 15px; font-weight: 600; color: \${accent}; text-transform: uppercase; margin-top: 4px; }
        .contact { font-size: 12.5px; color: \${text}; opacity: 0.8; margin-top: 8px; }
        .section { margin-bottom: 24px; }
        .section-title { font-size: 14.5px; font-weight: bold; text-transform: uppercase; color: \${accent}; border-bottom: 2px solid #E2E8F0; padding-bottom: 4px; margin-bottom: 12px; letter-spacing: 0.5px; }
        .item { margin-bottom: 16px; }
        .item-header { display: flex; justify-content: space-between; font-weight: bold; color: \${heading}; font-size: 13.5px; }
        .item-desc { font-size: 12.5px; color: \${text}; margin-top: 4px; text-align: justify; }
        .bullet-list { margin-top: 6px; padding-left: 20px; list-style-type: circle; }
        .bullet-item { font-size: 12px; margin-bottom: 2px; text-align: justify; color: \${text}; }
        .skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
        .skill-badge { background: #EFF6FF; color: \${accent}; padding: 4px 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; border: 1px solid #DBEAFE; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
          <div class="title">\${personalInfo?.title || ''}</div>
          <div class="contact">
            \${personalInfo?.email || ''} | \${personalInfo?.phone || ''} | \${personalInfo?.location || ''}
            \${personalInfo?.linkedin ? \` | in: \${personalInfo.linkedin}\` : ''}
            \${personalInfo?.github ? \` | gh: \${personalInfo.github}\` : ''}
          </div>
        </div>

        \${professionalSummary?.summary ? \`
        <div class="section">
          <div class="section-title">Profile Summary</div>
          <p style="font-size: 12.5px; text-align: justify;">\${professionalSummary.summary}</p>
        </div>\` : ''}

        \${workExperience && workExperience.length > 0 ? \`
        <div class="section">
          <div class="section-title">Career Experience</div>
          \${workExperience.map(w => \`
            <div class="item">
              <div class="item-header">
                <span>\${w.position} at <strong>\${w.company}</strong></span>
                <span style="font-weight: 500; font-size: 12px; color: \${text}; opacity: 0.8;">\${formatDateRange(w.startDate, w.endDate, w.current)}</span>
              </div>
              \${w.description ? \`<div class="item-desc">\${w.description}</div>\` : ''}
              \${w.achievements && w.achievements.length > 0 ? \`
                <ul class="bullet-list">
                  \${w.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
                </ul>
              \` : ''}
            </div>
          \`).join('')}
        </div>\` : ''}

        \${education && education.length > 0 ? \`
        <div class="section">
          <div class="section-title">Education Background</div>
          \${education.map(edu => \`
            <div class="item">
              <div class="item-header">
                <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
                <span style="font-weight: 500; font-size: 12px; color: \${text}; opacity: 0.8;">\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
              </div>
              <div style="font-size: 12px; color: \${text}; opacity: 0.85;">\${edu.institution} \${edu.gpa ? \` | GPA: \${edu.gpa}\` : ''}</div>
            </div>
          \`).join('')}
        </div>\` : ''}

        \${projects && projects.length > 0 ? \`
        <div class="section">
          <div class="section-title">Key Projects</div>
          \${projects.map(proj => \`
            <div class="item">
              <div class="item-header">
                <span>\${proj.name}</span>
                <span style="font-weight: 500; font-size: 12px; color: \${accent};">\${Array.isArray(proj.technologies) ? proj.technologies.slice(0, 5).join(', ') : (proj.technologies || '')}</span>
              </div>
              \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
            </div>
          \`).join('')}
        </div>\` : ''}

        \${skills && skills.length > 0 ? \`
        <div class="section">
          <div class="section-title">Skills & Technologies</div>
          <div class="skills-grid">
            \${skills.map(s => \`<span class="skill-badge">\${s.name}</span>\`).join('')}
          </div>
        </div>\` : ''}

        \${certifications && certifications.length > 0 ? \`
        <div class="section">
          <div class="section-title">Certifications</div>
          \${certifications.map(cert => \`
            <div class="item" style="margin-bottom: 6px;">
              <div class="item-header" style="font-size: 12.5px;">
                <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
                <span style="font-weight: 500; font-size: 12px; color: \${text};">\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
              </div>
            </div>
          \`).join('')}
        </div>\` : ''}

        \${languages && languages.length > 0 ? \`
        <div class="section">
          <div class="section-title">Languages</div>
          <p style="font-size: 12.5px;">
            \${languages.map(l => \`<strong>\${l.name}</strong> (\${l.proficiency || 'Intermediate'})\`).join('  |  ')}
          </p>
        </div>\` : ''}
      </div>
    </body>
    </html>
  \`;
};

const renderReactiveTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Open Sans';
  const heading = styles.headingColor || '#334155';
  const text = styles.textColor || '#333333';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', 'Open Sans', sans-serif; background: \${bg}; padding: 20px; color: \${text}; font-size: 12.5px; }
        .banner { background: \${heading}; color: #fff; padding: 24px; border-radius: 8px; margin-bottom: 20px; }
        .name { font-size: 26px; font-weight: bold; }
        .title { font-size: 14px; font-weight: 500; opacity: 0.9; margin-top: 2px; text-transform: uppercase; }
        .contact { font-size: 12px; margin-top: 8px; opacity: 0.9; }
        .section { margin-bottom: 18px; }
        .section-title { font-size: 13.5px; font-weight: bold; color: \${heading}; border-left: 4px solid \text: \${heading}; padding-left: 8px; margin-bottom: 12px; text-transform: uppercase; }
        .item { margin-bottom: 12px; }
        .item-header { display: flex; justify-content: space-between; font-weight: bold; color: \${heading}; font-size: 13px; }
        .item-subheader { display: flex; justify-content: space-between; font-size: 11.5px; font-style: italic; color: \${text}; margin: 2px 0 6px 0; }
        .item-desc { font-size: 12px; color: \${text}; text-align: justify; }
        .bullet-list { margin-top: 6px; padding-left: 20px; list-style-type: disc; }
        .bullet-item { font-size: 11.5px; margin-bottom: 2px; text-align: justify; color: \${text}; }
        .skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
        .skill-badge { background: #F1F5F9; color: \${heading}; padding: 4px 10px; border-radius: 4px; font-size: 11.5px; font-weight: 500; }
      </style>
    </head>
    <body>
      <div class="banner">
        <div class="name">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</div>
        <div class="title">\${personalInfo?.title || ''}</div>
        <div class="contact">
          \${personalInfo?.email || ''} | \${personalInfo?.phone || ''} | \${personalInfo?.location || ''}
          \${personalInfo?.linkedin ? \` | linkedin: \${personalInfo.linkedin}\` : ''}
          \${personalInfo?.github ? \` | github: \${personalInfo.github}\` : ''}
        </div>
      </div>

      \${professionalSummary?.summary ? \`
      <div class="section">
        <div class="section-title">About Me</div>
        <p style="text-align: justify; line-height: 1.5;">\${professionalSummary.summary}</p>
      </div>\` : ''}

      \${workExperience && workExperience.length > 0 ? \`
      <div class="section">
        <div class="section-title">Experience</div>
        \${workExperience.map(work => \`
          <div class="item">
            <div class="item-header">
              <span>\${work.position}</span>
              <span>\${formatDateRange(work.startDate, work.endDate, work.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${work.company}</span>
              <span>\${work.location || ''}</span>
            </div>
            \${work.description ? \`<div class="item-desc">\${work.description}</div>\` : ''}
            \${work.achievements && work.achievements.length > 0 ? \`
              <ul class="bullet-list">
                \${work.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
              </ul>
            \` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${education && education.length > 0 ? \`
      <div class="section">
        <div class="section-title">Education</div>
        \${education.map(edu => \`
          <div class="item">
            <div class="item-header">
              <span>\${edu.institution}</span>
              <span>\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
            </div>
            <div class="item-subheader">
              <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
              \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${projects && projects.length > 0 ? \`
      <div class="section">
        <div class="section-title">Projects</div>
        \${projects.map(proj => \`
          <div class="item">
            <div class="item-header">
              <span>\${proj.name}</span>
              <span>\${formatDateRange(proj.startDate, proj.endDate, false)}</span>
            </div>
            <div class="item-subheader">
              <span>\${Array.isArray(proj.technologies) ? proj.technologies.join(', ') : (proj.technologies || '')}</span>
              \${proj.url ? \`<span>\${proj.url}</span>\` : ''}
            </div>
            \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
          </div>
        \`).join('')}
      </div>\` : ''}

      \${skills && skills.length > 0 ? \`
      <div class="section">
        <div class="section-title">Skills</div>
        <div class="skills-grid">
          \${skills.map(s => \`<span class="skill-badge">\${s.name}</span>\`).join('')}
        </div>
      </div>\` : ''}

      \${certifications && certifications.length > 0 ? \`
      <div class="section">
        <div class="section-title">Certifications</div>
        \${certifications.map(cert => \`
          <div class="item" style="margin-bottom: 4px;">
            <div class="item-header">
              <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
              <span>\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
            </div>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${languages && languages.length > 0 ? \`
      <div class="section">
        <div class="section-title">Languages</div>
        <p style="font-size: 11.5px;">
          \${languages.map(l => \`\${l.name} (\${l.proficiency || 'Intermediate'})\`).join(' | ')}
        </p>
      </div>\` : ''}
    </body>
    </html>
  \`;
};

const renderCanvaTemplate = (resume, styles = {}) => {
  const { personalInfo, professionalSummary, education, workExperience, skills, certifications, projects, languages } = resume;
  const font = styles.font || 'Arial';
  const accent = styles.accentColor || '#1A365D';
  const heading = styles.headingColor || '#1A365D';
  const text = styles.textColor || '#2D3748';
  const bg = styles.bgColor || '#FFFFFF';

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: '\${font}', Arial, sans-serif; background: #f0f2f5; margin: 0; padding: 0; display: flex; min-height: 100vh; font-size: 12.5px; }
        .sidebar { width: 32%; background: \${accent}; color: #ffffff; padding: 25px 20px; box-sizing: border-box; }
        .main-body { width: 68%; background: \${bg}; padding: 25px; color: \${text}; box-sizing: border-box; }
        .sidebar h2 { font-size: 13.5px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 6px; margin-bottom: 12px; margin-top: 24px; text-transform: uppercase; letter-spacing: 0.5px; color: #ffffff; }
        .sidebar h2:first-of-type { margin-top: 0; }
        .main-body h2 { font-size: 14.5px; border-bottom: 2px solid \${accent}; padding-bottom: 4px; margin-bottom: 12px; margin-top: 24px; color: \${heading}; text-transform: uppercase; letter-spacing: 0.5px; }
        .main-body h2:first-of-type { margin-top: 0; }
        .contact-item { margin-bottom: 8px; font-size: 11.5px; line-height: 1.5; word-break: break-all; }
        .skill-item { margin-bottom: 5px; font-size: 11.5px; }
        .item { margin-bottom: 14px; }
        .item-header { display: flex; justify-content: space-between; font-weight: bold; color: \${heading}; font-size: 13px; }
        .item-subheader { display: flex; justify-content: space-between; font-size: 11.5px; font-style: italic; color: \text: \${text}; margin: 2px 0 6px 0; }
        .item-desc { font-size: 12px; color: \${text}; text-align: justify; }
        .bullet-list { margin-top: 4px; padding-left: 20px; list-style-type: disc; }
        .bullet-item { font-size: 11.5px; margin-bottom: 2px; text-align: justify; color: \${text}; }
      </style>
    </head>
    <body>
      <div class="sidebar">
        <h2>Contact</h2>
        <div class="contact-item">✉ \${personalInfo?.email || ''}</div>
        <div class="contact-item">📞 \${personalInfo?.phone || ''}</div>
        <div class="contact-item">📍 \${personalInfo?.location || ''}</div>
        \${personalInfo?.linkedin ? \`<div class="contact-item">in: \${personalInfo.linkedin}</div>\` : ''}
        \${personalInfo?.github ? \`<div class="contact-item">gh: \${personalInfo.github}</div>\` : ''}

        \${skills && skills.length > 0 ? \`
        <h2>Skills</h2>
        \${skills.map(s => \`<div class="skill-item">• \${s.name}</div>\`).join('')}
        \` : ''}

        \${languages && languages.length > 0 ? \`
        <h2>Languages</h2>
        \${languages.map(l => \`<div class="skill-item"><strong>\${l.name}</strong> (\${l.proficiency || 'Intermediate'})</div>\`).join('')}
        \` : ''}
      </div>
      <div class="main-body">
        <h1 style="font-size: 26px; color: \${heading}; font-weight: bold; margin-bottom: 2px;">\${personalInfo?.firstName || ''} \${personalInfo?.lastName || ''}</h1>
        <div style="font-size: 13.5px; font-weight: bold; margin-bottom: 16px; color: \${accent}; text-transform: uppercase;">\${personalInfo?.title || ''}</div>

        \${professionalSummary?.summary ? \`
        <div class="section">
          <h2>Professional Profile</h2>
          <p style="font-size: 12px; line-height: 1.55; text-align: justify;">\${professionalSummary.summary}</p>
        </div>\` : ''}

        \${workExperience && workExperience.length > 0 ? \`
        <div class="section">
          <h2>Work History</h2>
          \${workExperience.map(work => \`
            <div class="item">
              <div class="item-header">
                <span>\${work.position}</span>
                <span style="font-weight: 500; font-size: 11.5px; color: \${text};">\${formatDateRange(work.startDate, work.endDate, work.current)}</span>
              </div>
              <div class="item-subheader">
                <span>\${work.company}</span>
                <span>\${work.location || ''}</span>
              </div>
              \${work.description ? \`<div class="item-desc">\${work.description}</div>\` : ''}
              \${work.achievements && work.achievements.length > 0 ? \`
                <ul class="bullet-list">
                  \${work.achievements.map(ach => ach && ach.trim() ? \`<li class="bullet-item">\${ach.trim()}</li>\` : '').join('')}
                </ul>
              \` : ''}
            </div>
          \`).join('')}
        </div>\` : ''}

        \${education && education.length > 0 ? \`
        <div class="section">
          <h2>Education</h2>
          \${education.map(edu => \`
            <div class="item">
              <div class="item-header">
                <span>\${edu.institution}</span>
                <span style="font-weight: 500; font-size: 11.5px; color: \${text};">\${formatDateRange(edu.startDate, edu.endDate, edu.current)}</span>
              </div>
              <div class="item-subheader">
                <span>\${edu.degree} \${edu.fieldOfStudy ? 'in ' + edu.fieldOfStudy : ''}</span>
                \${edu.gpa ? \`<span>GPA: \${edu.gpa}</span>\` : ''}
              </div>
            </div>
          \`).join('')}
        </div>\` : ''}

        \${projects && projects.length > 0 ? \`
        <div class="section">
          <h2>Projects</h2>
          \${projects.map(proj => \`
            <div class="item">
              <div class="item-header">
                <span>\${proj.name}</span>
                <span style="font-weight: 500; font-size: 11.5px;">\${formatDateRange(proj.startDate, proj.endDate, false)}</span>
              </div>
              \${proj.description ? \`<div class="item-desc">\${proj.description}</div>\` : ''}
            </div>
          \`).join('')}
        </div>\` : ''}

        \${certifications && certifications.length > 0 ? \`
        <div class="section">
          <h2>Certifications</h2>
          \${certifications.map(cert => \`
            <div class="item" style="margin-bottom: 6px;">
              <div class="item-header" style="font-size: 12px;">
                <span>\${cert.name} \${cert.organization ? ' - ' + cert.organization : ''}</span>
                <span>\${cert.issueDate ? formatDate(cert.issueDate) : ''}</span>
              </div>
            </div>
          \`).join('')}
        </div>\` : ''}
      </div>
    </body>
    </html>
  \`;
};

export default function DummyTemplateServiceComponent() { return null; }
`;

const updatedContent = beforePart + newTemplatesCode;
fs.writeFileSync(filepath, updatedContent, 'utf8');
console.log('Successfully replaced all templates with fully-wired, full-feature versions!');
