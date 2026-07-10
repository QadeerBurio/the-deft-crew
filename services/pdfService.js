// services/pdfService.js
// ============================================================
// PDF Export Service using PDFKit
// ============================================================
// Generates a clean, professional, recruiter-friendly PDF
// resume from a Resume document. Streams the output to a
// writable stream (like the Express response).
// ============================================================

const PDFDocument = require('pdfkit');

/**
 * Format date to MM/YYYY or 'Present'
 */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Generate a PDF from a Resume model instance and pipe it to writableStream.
 *
 * @param {Object} resume - Mongoose Resume document
 * @param {NodeJS.WritableStream} writableStream - Where to stream the PDF
 */
function generateResumePDF(resume, writableStream) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 45, right: 45 },
    bufferPages: true
  });

  // Pipe output
  doc.pipe(writableStream);

  // Styling palette
  const primaryColor = '#1e3a8a';   // Deep Blue
  const secondaryColor = '#475569'; // Slate Gray
  const textColor = '#1e293b';      // Charcoal
  const lightGrey = '#f1f5f9';      // Cool grey background

  // ── Header: Name & Title ───────────────────────────────────────────────────
  const firstName = resume.personalInfo?.firstName || '';
  const lastName = resume.personalInfo?.lastName || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'Candidate Name';

  doc.fillColor(primaryColor)
     .font('Helvetica-Bold')
     .fontSize(24)
     .text(fullName, { align: 'left' });

  const jobTitle = resume.professionalSummary?.title || resume.targetJob?.jobTitle || '';
  if (jobTitle) {
    doc.fillColor(secondaryColor)
       .font('Helvetica-Oblique')
       .fontSize(14)
       .text(jobTitle, { align: 'left' });
  }

  doc.moveDown(0.3);

  // ── Contact Info Row ────────────────────────────────────────────────────────
  const contactParts = [];
  if (resume.personalInfo?.email) contactParts.push(resume.personalInfo.email);
  if (resume.personalInfo?.phone) contactParts.push(resume.personalInfo.phone);
  
  const city = resume.personalInfo?.city || '';
  const country = resume.personalInfo?.country || '';
  const location = [city, country].filter(Boolean).join(', ');
  if (location) contactParts.push(location);

  if (resume.personalInfo?.linkedin) {
    let cleanLi = resume.personalInfo.linkedin.replace(/https?:\/\/(www\.)?linkedin\.com\/in\//i, 'li/');
    contactParts.push(cleanLi.slice(0, 25));
  }
  if (resume.personalInfo?.portfolio) {
    contactParts.push(resume.personalInfo.portfolio.replace(/https?:\/\/(www\.)?/i, '').slice(0, 25));
  }

  doc.fillColor(textColor)
     .font('Helvetica')
     .fontSize(8.5)
     .text(contactParts.join('  |  '), { align: 'left' });

  doc.moveDown(0.5);

  // Horizontal Rule
  doc.strokeColor('#cbd5e1')
     .lineWidth(1)
     .moveTo(45, doc.y)
     .lineTo(550, doc.y)
     .stroke();

  doc.moveDown(0.8);

  // ── Section Helper ─────────────────────────────────────────────────────────
  function addSectionHeader(title) {
    doc.fillColor(primaryColor)
       .font('Helvetica-Bold')
       .fontSize(11)
       .text(title.toUpperCase());
    
    doc.strokeColor('#e2e8f0')
       .lineWidth(1)
       .moveTo(45, doc.y + 2)
       .lineTo(550, doc.y + 2)
       .stroke();

    doc.moveDown(0.6);
  }

  // ── 1. Professional Summary ───────────────────────────────────────────────
  const summaryText = resume.professionalSummary?.summary;
  if (summaryText) {
    addSectionHeader('Professional Summary');
    doc.fillColor(textColor)
       .font('Helvetica')
       .fontSize(9.5)
       .text(summaryText, { align: 'justify', lineGap: 2 });
    doc.moveDown(1.2);
  }

  // ── 2. Work Experience ────────────────────────────────────────────────────
  const experience = resume.workExperience || [];
  if (experience.length > 0) {
    addSectionHeader('Work Experience');
    
    experience.forEach((exp) => {
      // Heading line: Title @ Company, Location
      const startStr = formatDate(exp.startDate);
      const endStr = exp.current ? 'Present' : formatDate(exp.endDate);
      const dateRange = [startStr, endStr].filter(Boolean).join(' - ');

      doc.fillColor(textColor)
         .font('Helvetica-Bold')
         .fontSize(10)
         .text(`${exp.position || 'Role'} at ${exp.company || 'Company'}`, { continued: true });
      
      doc.fillColor(secondaryColor)
         .font('Helvetica')
         .fontSize(9)
         .text(`   ${dateRange}`, { align: 'right' });

      // Location if present
      if (exp.location) {
        doc.fillColor(secondaryColor)
           .font('Helvetica-Oblique')
           .fontSize(8.5)
           .text(exp.location, { align: 'left' });
      }

      doc.moveDown(0.2);

      // Description
      if (exp.description) {
        doc.fillColor(textColor)
           .font('Helvetica')
           .fontSize(9)
           .text(exp.description, { align: 'justify', lineGap: 1 });
      }

      // Achievements
      const achievements = exp.achievements || [];
      if (achievements.length > 0) {
        doc.moveDown(0.15);
        achievements.forEach((ach) => {
          if (!ach) return;
          doc.fillColor(textColor)
             .font('Helvetica')
             .fontSize(9)
             .text(`•  ${ach}`, { indent: 12, lineGap: 1.5 });
        });
      }

      doc.moveDown(1.0);
    });
  }

  // ── 3. Education ──────────────────────────────────────────────────────────
  const education = resume.education || [];
  if (education.length > 0) {
    addSectionHeader('Education');

    education.forEach((edu) => {
      const startStr = formatDate(edu.startDate);
      const endStr = edu.current ? 'Present' : formatDate(edu.endDate);
      const dateRange = [startStr, endStr].filter(Boolean).join(' - ');

      doc.fillColor(textColor)
         .font('Helvetica-Bold')
         .fontSize(10)
         .text(`${edu.degree || 'Degree'} in ${edu.fieldOfStudy || 'Field'}`, { continued: true });

      doc.fillColor(secondaryColor)
         .font('Helvetica')
         .fontSize(9)
         .text(`   ${dateRange}`, { align: 'right' });

      doc.fillColor(secondaryColor)
         .font('Helvetica')
         .fontSize(9)
         .text(edu.institution || 'Institution');

      if (edu.gpa) {
        doc.fillColor(textColor)
           .font('Helvetica-Oblique')
           .fontSize(8.5)
           .text(`GPA: ${edu.gpa}`);
      }

      doc.moveDown(0.8);
    });
  }

  // ── 4. Projects ───────────────────────────────────────────────────────────
  const projects = resume.projects || [];
  if (projects.length > 0) {
    addSectionHeader('Projects');

    projects.forEach((proj) => {
      const dateRange = [formatDate(proj.startDate), formatDate(proj.endDate)].filter(Boolean).join(' - ');

      doc.fillColor(textColor)
         .font('Helvetica-Bold')
         .fontSize(10)
         .text(proj.name || 'Project Name', { continued: true });

      if (dateRange) {
        doc.fillColor(secondaryColor)
           .font('Helvetica')
           .fontSize(9)
           .text(`   ${dateRange}`, { align: 'right' });
      } else {
        doc.text(''); // end the continued line
      }

      if (proj.technologies?.length > 0) {
        doc.fillColor(primaryColor)
           .font('Helvetica-Oblique')
           .fontSize(8.5)
           .text(`Technologies: ${proj.technologies.join(', ')}`);
      }

      if (proj.description) {
        doc.moveDown(0.15);
        doc.fillColor(textColor)
           .font('Helvetica')
           .fontSize(9)
           .text(proj.description, { align: 'justify', lineGap: 1 });
      }

      doc.moveDown(0.8);
    });
  }

  // ── 5. Skills ─────────────────────────────────────────────────────────────
  const skills = resume.skills || [];
  if (skills.length > 0) {
    addSectionHeader('Skills');

    // Group skills by category if possible
    const categorized = {};
    skills.forEach(s => {
      const cat = s.category || 'Technical';
      if (!categorized[cat]) categorized[cat] = [];
      categorized[cat].push(s.name);
    });

    Object.keys(categorized).forEach(cat => {
      doc.fillColor(textColor)
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(`${cat}: `, { continued: true })
         .font('Helvetica')
         .text(categorized[cat].join(', '));
      doc.moveDown(0.4);
    });
    
    doc.moveDown(0.6);
  }

  // ── 6. Certifications & Languages ─────────────────────────────────────────
  const certs = resume.certifications || [];
  const langs = resume.languages || [];

  if (certs.length > 0 || langs.length > 0) {
    addSectionHeader('Additional Information');

    if (certs.length > 0) {
      doc.fillColor(textColor)
         .font('Helvetica-Bold')
         .fontSize(9.5)
         .text('Certifications');
      
      certs.forEach(c => {
        const dateStr = formatDate(c.issueDate);
        const suffix = dateStr ? ` (${dateStr})` : '';
        doc.fillColor(textColor)
           .font('Helvetica')
           .fontSize(9)
           .text(`• ${c.name}${suffix} - ${c.organization || ''}`, { indent: 10 });
      });
      doc.moveDown(0.6);
    }

    if (langs.length > 0) {
      doc.fillColor(textColor)
         .font('Helvetica-Bold')
         .fontSize(9.5)
         .text('Languages');

      const langList = langs.map(l => `${l.name} (${l.proficiency || 'Intermediate'})`).join(', ');
      doc.fillColor(textColor)
         .font('Helvetica')
         .fontSize(9)
         .text(langList);
    }
  }

  // End Document
  doc.end();
}

module.exports = { generateResumePDF };
