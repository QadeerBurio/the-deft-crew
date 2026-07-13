const PDFDocument = require('pdfkit');

/**
 * Format date string to standard display format (e.g. "Jan 2024")
 */
const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

/**
 * Format start and end date range
 */
const formatDateRange = (start, end, current) => {
  const startStr = formatDate(start);
  const endStr = current ? 'Present' : formatDate(end);
  if (!startStr && !endStr) return '';
  if (!startStr) return endStr;
  if (!endStr) return startStr;
  return `${startStr} - ${endStr}`;
};

/**
 * Renders the resume object into a PDF and pipes it to the response stream
 * @param {Object} resume 
 * @param {Stream} res - Express response object
 */
function generateResumePDF(resume, res) {
  const {
    personalInfo,
    professionalSummary,
    education,
    workExperience,
    skills,
    certifications,
    projects,
    languages,
    targetJob
  } = resume;

  // Create a document with 0.5-inch margins (36pt)
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
    bufferPages: true
  });

  doc.pipe(res);

  // Styling Constants
  const PRIMARY_COLOR = '#1A365D'; // Dark Navy
  const TEXT_COLOR = '#2D3748'; // Charcoal Gray
  const MUTED_COLOR = '#718096'; // Muted Gray
  const FONT_REGULAR = 'Helvetica';
  const FONT_BOLD = 'Helvetica-Bold';
  const FONT_ITALIC = 'Helvetica-Oblique';

  // Helper: Draw Section Title
  const drawSectionTitle = (title) => {
    doc.moveDown(1.5);
    const currentY = doc.y;
    
    // Line above title
    doc.moveTo(36, currentY)
       .lineTo(559, currentY)
       .strokeColor('#E2E8F0')
       .lineWidth(1)
       .stroke();
    
    doc.moveDown(0.4);
    doc.fillColor(PRIMARY_COLOR)
       .font(FONT_BOLD)
       .fontSize(11)
       .text(title.toUpperCase(), { characterSpacing: 0.5 });
    
    doc.moveDown(0.3);
  };

  // --- HEADER SECTION ---
  const fullName = `${personalInfo?.firstName || ''} ${personalInfo?.lastName || ''}`.trim() || 'Resume';
  doc.fillColor(PRIMARY_COLOR)
     .font(FONT_BOLD)
     .fontSize(22)
     .text(fullName, { align: 'center' });

  // Subtitle/Role Title
  const roleTitle = personalInfo?.title || targetJob?.jobTitle || (professionalSummary?.title || '');
  if (roleTitle) {
    doc.moveDown(0.2);
    doc.fillColor(MUTED_COLOR)
       .font(FONT_REGULAR)
       .fontSize(12)
       .text(roleTitle.toUpperCase(), { align: 'center', characterSpacing: 0.5 });
  }

  // Contact Info Line
  doc.moveDown(0.3);
  const contactParts = [];
  if (personalInfo?.email) contactParts.push(personalInfo.email);
  if (personalInfo?.phone) contactParts.push(personalInfo.phone);
  if (personalInfo?.location) {
    contactParts.push(personalInfo.location);
  } else if (personalInfo?.city || personalInfo?.state) {
    const loc = [personalInfo.city, personalInfo.state].filter(Boolean).join(', ');
    if (loc) contactParts.push(loc);
  }
  if (personalInfo?.linkedin) {
    let cleanLi = personalInfo.linkedin.replace(/^(https?:\/\/)?(www\.)?linkedin\.com\/in\//, 'li/');
    contactParts.push(cleanLi);
  }
  if (personalInfo?.github) {
    let cleanGh = personalInfo.github.replace(/^(https?:\/\/)?(www\.)?github\.com\//, 'gh/');
    contactParts.push(cleanGh);
  }

  doc.fillColor(TEXT_COLOR)
     .font(FONT_REGULAR)
     .fontSize(8.5)
     .text(contactParts.join('  |  '), { align: 'center' });

  // --- SUMMARY SECTION ---
  if (professionalSummary?.summary) {
    drawSectionTitle('Professional Summary');
    doc.fillColor(TEXT_COLOR)
       .font(FONT_REGULAR)
       .fontSize(9.5)
       .lineGap(2)
       .text(professionalSummary.summary, { align: 'justify' });
  }

  // --- EXPERIENCE SECTION ---
  if (workExperience && workExperience.length > 0) {
    drawSectionTitle('Experience');
    
    workExperience.forEach((work, index) => {
      if (index > 0) doc.moveDown(0.8);
      
      // Header: Position + Date
      const positionText = work.position || 'Position';
      const dateText = formatDateRange(work.startDate, work.endDate, work.current);
      
      const startY = doc.y;
      doc.fillColor(PRIMARY_COLOR)
         .font(FONT_BOLD)
         .fontSize(10)
         .text(positionText, 36, startY, { continued: true })
         .fillColor(TEXT_COLOR)
         .font(FONT_REGULAR)
         .text(` @ ${work.company || 'Company'}`, { continued: false });
         
      doc.fillColor(MUTED_COLOR)
         .font(FONT_REGULAR)
         .fontSize(9)
         .text(dateText, 36, startY, { align: 'right' });

      // Subheader: Location (italic)
      if (work.location) {
        doc.moveDown(0.15);
        doc.fillColor(MUTED_COLOR)
           .font(FONT_ITALIC)
           .fontSize(8.5)
           .text(work.location);
      }

      // Main description (if any)
      if (work.description) {
        doc.moveDown(0.3);
        doc.fillColor(TEXT_COLOR)
           .font(FONT_REGULAR)
           .fontSize(9)
           .lineGap(1.5)
           .text(work.description, 36, doc.y, { align: 'justify', width: 523 });
      }

      // Bullet Achievements (IMPORTANT - WAS PREVIOUSLY DROPPED IN HTML TEMPLATES)
      if (work.achievements && work.achievements.length > 0) {
        doc.moveDown(0.2);
        work.achievements.forEach(ach => {
          if (ach && ach.trim()) {
            doc.fillColor(TEXT_COLOR)
               .font(FONT_REGULAR)
               .fontSize(9)
               .text('•', 46, doc.y, { continued: true })
               .text(` ${ach.trim()}`, 54, doc.y, { align: 'justify', width: 505 });
            doc.moveDown(0.1);
          }
        });
      }
      
      // Reset indentation margin
      doc.x = 36;
    });
  }

  // --- EDUCATION SECTION ---
  if (education && education.length > 0) {
    drawSectionTitle('Education');
    
    education.forEach((edu, index) => {
      if (index > 0) doc.moveDown(0.8);
      
      const degreeText = `${edu.degree || ''}${edu.fieldOfStudy ? ' in ' + edu.fieldOfStudy : ''}`.trim() || 'Degree';
      const schoolText = edu.institution || 'Institution';
      const dateText = formatDateRange(edu.startDate, edu.endDate, edu.current);

      const startY = doc.y;
      doc.fillColor(PRIMARY_COLOR)
         .font(FONT_BOLD)
         .fontSize(10)
         .text(degreeText, 36, startY, { continued: true })
         .fillColor(TEXT_COLOR)
         .font(FONT_REGULAR)
         .text(` - ${schoolText}`, { continued: false });

      doc.fillColor(MUTED_COLOR)
         .font(FONT_REGULAR)
         .fontSize(9)
         .text(dateText, 36, startY, { align: 'right' });

      let details = [];
      if (edu.gpa) details.push(`GPA: ${edu.gpa}`);
      if (edu.description) details.push(edu.description);
      
      if (details.length > 0) {
        doc.moveDown(0.2);
        doc.fillColor(TEXT_COLOR)
           .font(FONT_REGULAR)
           .fontSize(9)
           .text(details.join(' | '));
      }
    });
  }

  // --- PROJECTS SECTION ---
  if (projects && projects.length > 0) {
    drawSectionTitle('Projects');

    projects.forEach((proj, index) => {
      if (index > 0) doc.moveDown(0.8);

      const nameText = proj.name || 'Project Name';
      const dateText = formatDateRange(proj.startDate, proj.endDate, false);

      const startY = doc.y;
      doc.fillColor(PRIMARY_COLOR)
         .font(FONT_BOLD)
         .fontSize(10)
         .text(nameText, 36, startY);

      if (dateText) {
        doc.fillColor(MUTED_COLOR)
           .font(FONT_REGULAR)
           .fontSize(9)
           .text(dateText, 36, startY, { align: 'right' });
      }

      // Tech Stack
      if (proj.technologies && proj.technologies.length > 0) {
        doc.moveDown(0.15);
        const techs = Array.isArray(proj.technologies) ? proj.technologies.join(', ') : proj.technologies;
        doc.fillColor(MUTED_COLOR)
           .font(FONT_ITALIC)
           .fontSize(8.5)
           .text(`Technologies: ${techs}`);
      }

      // Description
      if (proj.description) {
        doc.moveDown(0.25);
        doc.fillColor(TEXT_COLOR)
           .font(FONT_REGULAR)
           .fontSize(9)
           .lineGap(1.5)
           .text(proj.description, { align: 'justify' });
      }
      
      // Link
      if (proj.url || proj.githubUrl) {
        doc.moveDown(0.15);
        const links = [proj.url, proj.githubUrl].filter(Boolean);
        doc.fillColor(PRIMARY_COLOR)
           .font(FONT_REGULAR)
           .fontSize(8.5)
           .text(`Link: ${links.join(' | ')}`);
      }
    });
  }

  // --- SKILLS SECTION ---
  if (skills && skills.length > 0) {
    drawSectionTitle('Skills & Expertise');
    
    // Group skills by category
    const categorized = {};
    skills.forEach(s => {
      const cat = s.category || 'General Skills';
      if (!categorized[cat]) categorized[cat] = [];
      categorized[cat].push(s.name);
    });

    Object.keys(categorized).forEach((cat, idx) => {
      if (idx > 0) doc.moveDown(0.4);
      
      const skillLine = categorized[cat].join(', ');
      doc.fillColor(TEXT_COLOR)
         .font(FONT_BOLD)
         .fontSize(9)
         .text(`${cat}: `, { continued: true })
         .font(FONT_REGULAR)
         .text(skillLine);
    });
  }

  // --- CERTIFICATIONS SECTION ---
  if (certifications && certifications.length > 0) {
    drawSectionTitle('Certifications');

    certifications.forEach((cert, index) => {
      if (index > 0) doc.moveDown(0.4);

      const nameText = cert.name || 'Certification';
      const orgText = cert.organization ? ` - ${cert.organization}` : '';
      const dateText = cert.issueDate ? `Issued: ${formatDate(cert.issueDate)}` : '';

      const startY = doc.y;
      doc.fillColor(TEXT_COLOR)
         .font(FONT_BOLD)
         .fontSize(9)
         .text(nameText, 36, startY, { continued: true })
         .font(FONT_REGULAR)
         .text(orgText, { continued: false });

      if (dateText) {
        doc.fillColor(MUTED_COLOR)
           .font(FONT_REGULAR)
           .fontSize(9)
           .text(dateText, 36, startY, { align: 'right' });
      }
    });
  }

  // --- LANGUAGES SECTION ---
  if (languages && languages.length > 0) {
    drawSectionTitle('Languages');
    
    const langLines = languages.map(l => `${l.name} (${l.proficiency || 'Intermediate'})`).join(', ');
    doc.fillColor(TEXT_COLOR)
       .font(FONT_REGULAR)
       .fontSize(9.5)
       .text(langLines);
  }

  // Finalize PDF file
  doc.end();
}

module.exports = {
  generateResumePDF
};
