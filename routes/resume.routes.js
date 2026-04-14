const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const Resume = require('../models/Resume');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const templateService = require('../services/Template');
// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper function to clean and validate resume data
const cleanResumeData = (data) => {
  const cleaned = { ...data };
  
  // Clean URLs - remove if invalid
  if (cleaned.linkedin && !cleaned.linkedin.match(/^(https?:\/\/)?(www\.)?linkedin\.com\/.*$/)) {
    delete cleaned.linkedin;
  }
  if (cleaned.github && !cleaned.github.match(/^(https?:\/\/)?(www\.)?github\.com\/.*$/)) {
    delete cleaned.github;
  }
  
  // Clean languages - ensure level is valid
  if (cleaned.languages && Array.isArray(cleaned.languages)) {
    cleaned.languages = cleaned.languages.map(lang => {
      const validLevels = ['Basic', 'Conversational', 'Professional', 'Native'];
      let level = lang.level ? lang.level.trim() : 'Basic';
      // Capitalize first letter
      level = level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
      if (!validLevels.includes(level)) {
        level = 'Basic';
      }
      return { ...lang, level };
    });
  }
  
  // Clean empty strings
  Object.keys(cleaned).forEach(key => {
    if (cleaned[key] === '') {
      delete cleaned[key];
    }
  });
  
  return cleaned;
};

// ==================== RESUME CRUD OPERATIONS ====================

// GET user's resume
router.get('/', authMiddleware, async (req, res) => {
  try {
    let resume = await Resume.findOne({ userId: req.userId });
    
    if (!resume) {
      // Return empty template structure instead of 404
      return res.json({
        fullName: '',
        email: '',
        phone: '',
        linkedin: '',
        github: '',
        portfolio: '',
        summary: '',
        education: [],
        experience: [],
        projects: [],
        certifications: [],
        languages: [],
        skills: [],
        templateId: 'modern',
        completionScore: 0
      });
    }
    
    res.json(resume);
  } catch (error) {
    console.error('Error fetching resume:', error);
    res.status(500).json({ error: 'Failed to fetch resume', details: error.message });
  }
});

// CREATE or UPDATE resume
router.post('/', authMiddleware, async (req, res) => {
  try {
    let resume = await Resume.findOne({ userId: req.userId });
    
    // Clean the incoming data
    const cleanedData = cleanResumeData(req.body);
    
    const resumeData = {
      ...cleanedData,
      userId: req.userId,
      updatedAt: Date.now()
    };
    
    if (resume) {
      // Update existing resume
      Object.assign(resume, resumeData);
      await resume.save();
    } else {
      // Create new resume
      resume = new Resume(resumeData);
      await resume.save();
    }
    
    res.json({ 
      success: true, 
      message: 'Resume saved successfully', 
      resume,
      completionScore: resume.completionScore
    });
  } catch (error) {
    console.error('Error saving resume:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = {};
      for (let field in error.errors) {
        errors[field] = error.errors[field].message;
      }
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors,
        message: error.message
      });
    }
    
    res.status(500).json({ error: 'Failed to save resume', details: error.message });
  }
});

// UPDATE specific section
router.patch('/:section', authMiddleware, async (req, res) => {
  try {
    const { section } = req.params;
    const { data } = req.body;
    
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    
    const allowedSections = ['education', 'experience', 'projects', 'certifications', 'languages', 'skills', 'personal', 'summary'];
    if (!allowedSections.includes(section)) {
      return res.status(400).json({ error: 'Invalid section' });
    }
    
    if (section === 'personal') {
      const cleanedData = cleanResumeData(data);
      Object.assign(resume, cleanedData);
    } else if (section === 'summary') {
      resume.summary = data;
    } else if (section === 'languages') {
      // Clean languages data
      const cleanedLanguages = data.map(lang => ({
        ...lang,
        level: lang.level ? lang.level.trim() : 'Basic'
      }));
      resume[section] = cleanedLanguages;
    } else {
      resume[section] = data;
    }
    
    await resume.save();
    res.json({ success: true, message: `${section} updated successfully`, resume });
  } catch (error) {
    console.error('Error updating section:', error);
    res.status(500).json({ error: 'Failed to update section', details: error.message });
  }
});

// DELETE resume
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const resume = await Resume.findOneAndDelete({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    res.json({ success: true, message: 'Resume deleted successfully' });
  } catch (error) {
    console.error('Error deleting resume:', error);
    res.status(500).json({ error: 'Failed to delete resume', details: error.message });
  }
});

// ==================== PDF GENERATION ====================

// Generate PDF with selected template
router.post('/generate-pdf', authMiddleware, async (req, res) => {
  try {
    const { templateId = 'modern' } = req.body;
    const resume = await Resume.findOne({ userId: req.userId });
    
    if (!resume) {
      return res.status(404).json({ error: 'No resume found. Please create a resume first.' });
    }
    
    // Validate required fields
    if (!resume.fullName || !resume.email || !resume.phone) {
      return res.status(400).json({ 
        error: 'Please complete your personal information before generating PDF' 
      });
    }
    
    const filename = `resume_${resume.userId}_${Date.now()}.pdf`;
    const filepath = path.join(uploadsDir, filename);
    
    const doc = new PDFDocument({ 
      margin: 50, 
      size: 'A4',
      info: {
        Title: `${resume.fullName} - Resume`,
        Author: resume.fullName,
        Subject: 'Professional Resume',
        Keywords: 'resume, cv, professional'
      }
    });
    
    const writeStream = fs.createWriteStream(filepath);
    doc.pipe(writeStream);
    
    // Generate PDF based on template
    switch(templateId) {
      case 'modern':
        await generateModernTemplate(doc, resume);
        break;
      case 'classic':
        await generateClassicTemplate(doc, resume);
        break;
      case 'professional':
        await generateProfessionalTemplate(doc, resume);
        break;
      default:
        await generateModernTemplate(doc, resume);
    }
    
    doc.end();
    
    writeStream.on('finish', () => {
      const pdfUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
      res.json({ 
        success: true, 
        pdfUrl,
        filename,
        message: 'PDF generated successfully'
      });
    });
    
    writeStream.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
    });
    
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
  }
});
// Update the PDF generation endpoint in your resume.routes.js

// Generate PDF with specific template
router.post('/generate-pdf/:templateId', authMiddleware, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { options = {} } = req.body;
    
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'No resume found. Please create a resume first.' });
    }
    
    // Validate required fields
    if (!resume.fullName || !resume.email || !resume.phone) {
      return res.status(400).json({ 
        error: 'Please complete your personal information before generating PDF' 
      });
    }
    
    const template = templateService.getTemplateById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const filename = `resume_${resume.userId}_${templateId}_${Date.now()}.pdf`;
    const filepath = path.join(uploadsDir, filename);
    
    const doc = await templateService.generatePDF(resume, templateId, options);
    
    const writeStream = fs.createWriteStream(filepath);
    doc.pipe(writeStream);
    doc.end();
    
    writeStream.on('finish', () => {
      // Increment download count
      resume.downloadCount += 1;
      resume.save();
      
      // FIXED: Use localhost IP for local development
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const pdfUrl = `${baseUrl}/uploads/${filename}`;
      
      console.log('PDF generated at:', pdfUrl);
      
      res.json({ 
        success: true, 
        pdfUrl,
        filename,
        template: template.name,
        message: 'PDF generated successfully'
      });
    });
    
    writeStream.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
    });
    
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
  }
});
// In resume.routes.js - Alternative endpoint for base64 PDF
router.post('/generate-pdf-base64/:templateId', authMiddleware, async (req, res) => {
  try {
    const { templateId } = req.params;
    const resume = await Resume.findOne({ userId: req.userId });
    
    if (!resume) {
      return res.status(404).json({ error: 'No resume found' });
    }
    
    const doc = await templateService.generatePDF(resume, templateId);
    
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      const base64 = pdfBuffer.toString('base64');
      res.json({ 
        success: true, 
        pdfBase64: base64,
        filename: `resume_${Date.now()}.pdf`
      });
    });
    doc.end();
    
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});
// PDF Template Functions
async function generateModernTemplate(doc, resume) {
  // Header with gradient effect using colors
  doc.rect(0, 0, doc.page.width, 160).fill('#4f46e5');
  
  // Name
  doc.fillColor('#ffffff')
    .fontSize(32)
    .font('Helvetica-Bold')
    .text(resume.fullName, 50, 45);
  
  // Title/Headline
  if (resume.summary) {
    const headline = resume.summary.split('.')[0].substring(0, 100);
    doc.fontSize(14)
      .font('Helvetica')
      .text(headline, 50, 90, { width: doc.page.width - 100 });
  }
  
  // Contact info
  doc.fontSize(10)
    .font('Helvetica')
    .text(`${resume.email}  |  ${resume.phone}`, 50, 125);
  
  if (resume.linkedin || resume.github) {
    let social = [];
    if (resume.linkedin) social.push(`LinkedIn: ${resume.linkedin.replace(/^https?:\/\//, '').replace(/^www\./, '')}`);
    if (resume.github) social.push(`GitHub: ${resume.github.replace(/^https?:\/\//, '').replace(/^www\./, '')}`);
    doc.text(social.join('  |  '), 50, 140, { width: doc.page.width - 100 });
  }
  
  let yPos = 190;
  
  // Professional Summary
  if (resume.summary) {
    doc.fillColor('#1e293b')
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('Professional Summary', 50, yPos);
    
    yPos += 25;
    doc.fontSize(11)
      .font('Helvetica')
      .text(resume.summary, 50, yPos, {
        width: doc.page.width - 100,
        align: 'justify',
        lineGap: 4
      });
    
    yPos += doc.heightOfString(resume.summary, { width: doc.page.width - 100 }) + 20;
  }
  
  // Work Experience
  if (resume.experience && resume.experience.length > 0) {
    if (yPos > 700) {
      doc.addPage();
      yPos = 50;
    }
    
    doc.fillColor('#1e293b')
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('Work Experience', 50, yPos);
    
    yPos += 25;
    
    for (const exp of resume.experience) {
      if (yPos > 750) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.fillColor('#4f46e5')
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(exp.title, 50, yPos);
      
      doc.fillColor('#64748b')
        .fontSize(11)
        .font('Helvetica')
        .text(`${exp.company} | ${exp.startDate} - ${exp.endDate}`, 50, yPos + 18);
      
      if (exp.desc) {
        doc.fillColor('#334155')
          .fontSize(10)
          .font('Helvetica')
          .text(exp.desc, 50, yPos + 35, {
            width: doc.page.width - 100,
            lineGap: 3
          });
        yPos += 55 + doc.heightOfString(exp.desc, { width: doc.page.width - 100 });
      } else {
        yPos += 40;
      }
      
      yPos += 10;
    }
  }
  
  // Education
  if (resume.education && resume.education.length > 0) {
    if (yPos > 700) {
      doc.addPage();
      yPos = 50;
    }
    
    doc.fillColor('#1e293b')
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('Education', 50, yPos);
    
    yPos += 25;
    
    for (const edu of resume.education) {
      if (yPos > 750) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.fillColor('#4f46e5')
        .fontSize(13)
        .font('Helvetica-Bold')
        .text(edu.degree, 50, yPos);
      
      doc.fillColor('#64748b')
        .fontSize(11)
        .font('Helvetica')
        .text(`${edu.school} | ${edu.startDate} - ${edu.endDate}`, 50, yPos + 18);
      
      if (edu.description) {
        doc.fillColor('#334155')
          .fontSize(10)
          .font('Helvetica')
          .text(edu.description, 50, yPos + 35, {
            width: doc.page.width - 100
          });
        yPos += 55;
      } else {
        yPos += 40;
      }
      
      yPos += 10;
    }
  }
  
  // Skills
  if (resume.skills && resume.skills.length > 0) {
    if (yPos > 750) {
      doc.addPage();
      yPos = 50;
    }
    
    doc.fillColor('#1e293b')
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('Technical Skills', 50, yPos);
    
    yPos += 25;
    
    const skillsPerRow = 3;
    const skillWidth = (doc.page.width - 100) / skillsPerRow;
    
    resume.skills.forEach((skill, index) => {
      const col = index % skillsPerRow;
      const row = Math.floor(index / skillsPerRow);
      const x = 50 + (col * skillWidth);
      const y = yPos + (row * 25);
      
      doc.fillColor('#475569')
        .fontSize(10)
        .font('Helvetica')
        .text(`• ${skill}`, x, y, { width: skillWidth - 10 });
    });
    
    yPos += Math.ceil(resume.skills.length / skillsPerRow) * 25 + 20;
  }
}

async function generateClassicTemplate(doc, resume) {
  doc.fillColor('#000000');
  
  doc.fontSize(28)
    .font('Helvetica-Bold')
    .text(resume.fullName, 50, 50, { align: 'center' });
  
  doc.fontSize(11)
    .font('Helvetica')
    .text(`${resume.email} | ${resume.phone}`, 50, 90, { align: 'center' });
  
  if (resume.linkedin || resume.github) {
    let social = [];
    if (resume.linkedin) social.push(resume.linkedin.replace(/^https?:\/\//, '').replace(/^www\./, ''));
    if (resume.github) social.push(resume.github.replace(/^https?:\/\//, '').replace(/^www\./, ''));
    doc.text(social.join(' | '), 50, 108, { align: 'center' });
  }
  
  doc.moveTo(50, 130).lineTo(doc.page.width - 50, 130).stroke();
  
  let yPos = 150;
  
  if (resume.summary) {
    doc.fontSize(14).font('Helvetica-Bold').text('SUMMARY', 50, yPos);
    doc.fontSize(10).font('Helvetica').text(resume.summary, 50, yPos + 20, {
      width: doc.page.width - 100,
      align: 'justify'
    });
    yPos += 50 + doc.heightOfString(resume.summary, { width: doc.page.width - 100 });
  }
  
  if (resume.experience && resume.experience.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').text('EXPERIENCE', 50, yPos);
    yPos += 25;
    
    for (const exp of resume.experience) {
      doc.fontSize(11).font('Helvetica-Bold').text(exp.title, 50, yPos);
      doc.fontSize(10).font('Helvetica').text(`${exp.company} (${exp.startDate} - ${exp.endDate})`, 50, yPos + 15);
      
      if (exp.desc) {
        doc.fontSize(9).font('Helvetica').text(exp.desc, 50, yPos + 30, {
          width: doc.page.width - 100
        });
        yPos += 55 + doc.heightOfString(exp.desc, { width: doc.page.width - 100 });
      } else {
        yPos += 35;
      }
      yPos += 10;
    }
  }
  
  if (resume.education && resume.education.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').text('EDUCATION', 50, yPos);
    yPos += 25;
    
    for (const edu of resume.education) {
      doc.fontSize(11).font('Helvetica-Bold').text(edu.degree, 50, yPos);
      doc.fontSize(10).font('Helvetica').text(`${edu.school} (${edu.startDate} - ${edu.endDate})`, 50, yPos + 15);
      yPos += 40;
    }
  }
}

async function generateProfessionalTemplate(doc, resume) {
  const leftColWidth = 120;
  const rightColX = leftColWidth + 30;
  
  doc.rect(0, 0, leftColWidth + 20, doc.page.height).fill('#f8fafc');
  
  doc.fillColor('#1e293b');
  doc.fontSize(12).font('Helvetica-Bold').text('CONTACT', 30, 50);
  
  doc.fontSize(9).font('Helvetica');
  let yPos = 75;
  doc.text(resume.email, 30, yPos);
  yPos += 20;
  doc.text(resume.phone, 30, yPos);
  yPos += 20;
  
  if (resume.linkedin) {
    doc.text('LinkedIn', 30, yPos);
    yPos += 15;
    doc.fontSize(8).text(resume.linkedin.replace(/^https?:\/\//, '').replace(/^www\./, ''), 30, yPos, { width: leftColWidth - 20 });
    yPos += 25;
  }
  
  if (resume.github) {
    doc.fontSize(9).font('Helvetica-Bold').text('GitHub', 30, yPos);
    yPos += 15;
    doc.fontSize(8).text(resume.github.replace(/^https?:\/\//, '').replace(/^www\./, ''), 30, yPos, { width: leftColWidth - 20 });
    yPos += 25;
  }
  
  if (resume.skills && resume.skills.length > 0) {
    doc.fontSize(12).font('Helvetica-Bold').text('SKILLS', 30, yPos);
    yPos += 20;
    
    resume.skills.forEach(skill => {
      doc.fontSize(9).font('Helvetica').text(`• ${skill}`, 30, yPos);
      yPos += 18;
    });
    yPos += 10;
  }
  
  if (resume.languages && resume.languages.length > 0) {
    doc.fontSize(12).font('Helvetica-Bold').text('LANGUAGES', 30, yPos);
    yPos += 20;
    
    resume.languages.forEach(lang => {
      doc.fontSize(9).font('Helvetica').text(`${lang.language}: ${lang.level}`, 30, yPos);
      yPos += 18;
    });
  }
  
  doc.fillColor('#000000');
  doc.fontSize(26).font('Helvetica-Bold').text(resume.fullName, rightColX, 50);
  
  if (resume.summary) {
    const title = resume.summary.split('.')[0].substring(0, 60);
    doc.fontSize(11).font('Helvetica').fillColor('#64748b').text(title, rightColX, 90);
    doc.fillColor('#000000');
  }
  
  let rightY = 120;
  
  if (resume.summary) {
    doc.fontSize(12).font('Helvetica-Bold').text('PROFILE', rightColX, rightY);
    rightY += 20;
    doc.fontSize(9).font('Helvetica').text(resume.summary, rightColX, rightY, {
      width: doc.page.width - rightColX - 50,
      align: 'justify'
    });
    rightY += doc.heightOfString(resume.summary, { width: doc.page.width - rightColX - 50 }) + 20;
  }
  
  if (resume.experience && resume.experience.length > 0) {
    doc.fontSize(12).font('Helvetica-Bold').text('WORK EXPERIENCE', rightColX, rightY);
    rightY += 25;
    
    for (const exp of resume.experience) {
      doc.fontSize(10).font('Helvetica-Bold').text(exp.title, rightColX, rightY);
      doc.fontSize(9).font('Helvetica').text(`${exp.company} | ${exp.startDate} - ${exp.endDate}`, rightColX, rightY + 13);
      
      if (exp.desc) {
        doc.fontSize(8).font('Helvetica').text(exp.desc, rightColX, rightY + 28, {
          width: doc.page.width - rightColX - 50
        });
        rightY += 50 + doc.heightOfString(exp.desc, { width: doc.page.width - rightColX - 50 });
      } else {
        rightY += 35;
      }
      rightY += 10;
    }
  }
  
  if (resume.education && resume.education.length > 0) {
    doc.fontSize(12).font('Helvetica-Bold').text('EDUCATION', rightColX, rightY);
    rightY += 25;
    
    for (const edu of resume.education) {
      doc.fontSize(10).font('Helvetica-Bold').text(edu.degree, rightColX, rightY);
      doc.fontSize(9).font('Helvetica').text(`${edu.school} | ${edu.startDate} - ${edu.endDate}`, rightColX, rightY + 13);
      rightY += 40;
    }
  }
}

// ==================== RESUME SHARING ====================

router.post('/share', authMiddleware, async (req, res) => {
  try {
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'No resume found to share' });
    }
    
    let publicUrl = resume.publicUrl;
    if (!publicUrl) {
      publicUrl = await resume.generatePublicUrl();
    }
    
    resume.isPublic = true;
    await resume.save();
    
    const shareUrl = `${req.protocol}://${req.get('host')}/api/resume/public/${publicUrl}`;
    
    const qrCodePath = path.join(uploadsDir, `qr_${resume.userId}.png`);
    await QRCode.toFile(qrCodePath, shareUrl);
    const qrCodeUrl = `${req.protocol}://${req.get('host')}/uploads/qr_${resume.userId}.png`;
    
    res.json({
      success: true,
      shareUrl,
      qrCodeUrl,
      publicUrl
    });
  } catch (error) {
    console.error('Error generating share link:', error);
    res.status(500).json({ error: 'Failed to generate share link', details: error.message });
  }
});

router.get('/public/:publicUrl', async (req, res) => {
  try {
    const { publicUrl } = req.params;
    const resume = await Resume.findOne({ publicUrl, isPublic: true });
    
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found or not shared' });
    }
    
    resume.viewCount += 1;
    await resume.save();
    
    const publicData = {
      fullName: resume.fullName,
      summary: resume.summary,
      experience: resume.experience,
      education: resume.education,
      skills: resume.skills,
      certifications: resume.certifications,
      languages: resume.languages,
      projects: resume.projects
    };
    
    res.json(publicData);
  } catch (error) {
    console.error('Error fetching public resume:', error);
    res.status(500).json({ error: 'Failed to fetch resume' });
  }
});

// ==================== AI IMPROVEMENTS ====================

router.post('/ai-improve', authMiddleware, async (req, res) => {
  try {
    const { text, type } = req.body;
    
    if (!text || !type) {
      return res.status(400).json({ error: 'Text and type are required' });
    }
    
    let improvedText = text;
    
    switch(type) {
      case 'summary':
        improvedText = enhanceSummary(text);
        break;
      case 'experience':
        improvedText = enhanceExperience(text);
        break;
      case 'achievement':
        improvedText = enhanceAchievement(text);
        break;
      default:
        improvedText = text;
    }
    
    res.json({ 
      success: true, 
      original: text,
      improved: improvedText,
      improvements: getImprovementDetails(text, improvedText)
    });
  } catch (error) {
    console.error('AI improvement error:', error);
    res.status(500).json({ error: 'Failed to improve text', details: error.message });
  }
});

function enhanceSummary(text) {
  let enhanced = text;
  
  const actionVerbs = ['managed', 'developed', 'created', 'implemented', 'led', 'designed'];
  let hasActionVerb = actionVerbs.some(verb => text.toLowerCase().includes(verb));
  
  if (!hasActionVerb && text.length > 20) {
    enhanced = `Experienced ${text}`;
  }
  
  if (!text.includes('%') && !text.includes('increased') && !text.includes('improved')) {
    enhanced += ' Proven track record of delivering measurable results and exceeding expectations.';
  }
  
  return enhanced;
}

function enhanceExperience(text) {
  let enhanced = text;
  
  const startsWithAction = /^(Managed|Led|Developed|Created|Implemented|Designed|Built|Launched)/i.test(text);
  if (!startsWithAction && text.length > 10) {
    enhanced = `• ${text.charAt(0).toUpperCase() + text.slice(1)}`;
  }
  
  if (!text.includes('%') && !text.includes('dollar') && !text.includes('USD')) {
    enhanced += ' resulting in significant improvements and cost savings.';
  }
  
  return enhanced;
}

function enhanceAchievement(text) {
  const achievementStarters = [
    'Successfully', 'Recognized for', 'Awarded for', 'Achieved', 'Exceeded'
  ];
  
  let enhanced = text;
  let hasStarter = achievementStarters.some(starter => 
    text.toLowerCase().startsWith(starter.toLowerCase())
  );
  
  if (!hasStarter) {
    enhanced = `Successfully ${text.toLowerCase()}`;
  }
  
  return enhanced;
}

function getImprovementDetails(original, improved) {
  const changes = [];
  
  if (original.length !== improved.length) {
    changes.push(`Length optimized from ${original.length} to ${improved.length} characters`);
  }
  
  if (improved.includes('successfully') && !original.includes('successfully')) {
    changes.push('Added action-oriented language');
  }
  
  if ((improved.includes('%') || improved.includes('increased')) && !original.includes('%')) {
    changes.push('Included quantifiable results');
  }
  
  return changes;
}

// ==================== ANALYTICS & INSIGHTS ====================

router.get('/analytics', authMiddleware, async (req, res) => {
  try {
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    
    const analytics = {
      completionScore: resume.completionScore,
      viewCount: resume.viewCount,
      lastUpdated: resume.updatedAt,
      createdAt: resume.createdAt,
      sections: {
        personal: {
          complete: !!(resume.fullName && resume.email && resume.phone),
          missing: getMissingPersonalFields(resume)
        },
        experience: {
          count: resume.experience.length,
          complete: resume.experience.length > 0
        },
        education: {
          count: resume.education.length,
          complete: resume.education.length > 0
        },
        skills: {
          count: resume.skills.length,
          complete: resume.skills.length >= 3,
          recommendation: resume.skills.length < 5 ? 'Add 2-3 more relevant skills' : null
        }
      },
      recommendations: generateRecommendations(resume)
    };
    
    res.json(analytics);
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

function getMissingPersonalFields(resume) {
  const missing = [];
  if (!resume.fullName) missing.push('Full Name');
  if (!resume.email) missing.push('Email');
  if (!resume.phone) missing.push('Phone Number');
  if (!resume.summary || resume.summary.length < 50) missing.push('Professional Summary (min 50 characters)');
  return missing;
}

function generateRecommendations(resume) {
  const recommendations = [];
  
  if (resume.completionScore < 70) {
    recommendations.push({
      priority: 'high',
      message: 'Complete your profile to increase chances of getting noticed',
      action: 'Fill in all personal details and add a professional summary'
    });
  }
  
  if (resume.experience.length === 0) {
    recommendations.push({
      priority: 'high',
      message: 'Add work experience to showcase your professional background',
      action: 'Include internships, freelance work, or relevant projects'
    });
  }
  
  if (resume.skills.length < 5) {
    recommendations.push({
      priority: 'medium',
      message: 'Add more technical and soft skills',
      action: 'Include both hard skills (programming, tools) and soft skills (leadership, communication)'
    });
  }
  
  if (resume.certifications.length === 0) {
    recommendations.push({
      priority: 'low',
      message: 'Add certifications to validate your expertise',
      action: 'Include online course certificates, professional certifications, or training programs'
    });
  }
  
  if (resume.summary && resume.summary.length < 100) {
    recommendations.push({
      priority: 'medium',
      message: 'Expand your professional summary',
      action: 'Include your key achievements, career goals, and unique value proposition'
    });
  }
  
  return recommendations;
}

// ==================== TEMPLATE MANAGEMENT ====================

router.get('/templates', authMiddleware, async (req, res) => {
  const templates = [
    {
      id: 'modern',
      name: 'Modern',
      description: 'Clean and contemporary design with gradient accents',
      colors: ['#4f46e5', '#818cf8'],
      bestFor: ['Tech', 'Creative', 'Startup']
    },
    {
      id: 'classic',
      name: 'Classic',
      description: 'Traditional layout perfect for corporate roles',
      colors: ['#1e293b', '#475569'],
      bestFor: ['Corporate', 'Finance', 'Law']
    },
    {
      id: 'professional',
      name: 'Professional',
      description: 'Two-column design highlighting skills and experience',
      colors: ['#0f172a', '#334155'],
      bestFor: ['Executive', 'Management', 'Academic']
    }
  ];
  
  res.json(templates);
});

router.patch('/template/:templateId', authMiddleware, async (req, res) => {
  try {
    const { templateId } = req.params;
    const validTemplates = ['modern', 'classic', 'professional'];
    
    if (!validTemplates.includes(templateId)) {
      return res.status(400).json({ error: 'Invalid template selection' });
    }
    
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    
    resume.templateId = templateId;
    await resume.save();
    
    res.json({ success: true, message: 'Template updated successfully', templateId });
  } catch (error) {
    console.error('Template update error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});
// GET all templates
router.get('/templates/all', authMiddleware, async (req, res) => {
  try {
    const { category, industry, experienceLevel, search } = req.query;
    const filters = { category, industry, experienceLevel, search };
    
    const templates = templateService.getAllTemplates(filters);
    
    res.json({
      success: true,
      count: templates.length,
      templates
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});
// GET templates by category
router.get('/templates/category/:category', authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const templates = templateService.getTemplatesByCategory(category);
    
    res.json({
      success: true,
      category,
      count: templates.length,
      templates
    });
  } catch (error) {
    console.error('Error fetching templates by category:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// GET single template details
router.get('/templates/:templateId', authMiddleware, async (req, res) => {
  try {
    const { templateId } = req.params;
    const template = templateService.getTemplateById(templateId);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json({ success: true, template });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// Generate PDF with specific template
router.post('/generate-pdf/:templateId', authMiddleware, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { options = {} } = req.body;
    
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'No resume found. Please create a resume first.' });
    }
    
    // Validate required fields
    if (!resume.fullName || !resume.email || !resume.phone) {
      return res.status(400).json({ 
        error: 'Please complete your personal information before generating PDF' 
      });
    }
    
    const template = templateService.getTemplateById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const filename = `resume_${resume.userId}_${templateId}_${Date.now()}.pdf`;
    const filepath = path.join(uploadsDir, filename);
    
    const doc = await templateService.generatePDF(resume, templateId, options);
    
    const writeStream = fs.createWriteStream(filepath);
    doc.pipe(writeStream);
    doc.end();
    
    writeStream.on('finish', () => {
      // Increment download count
      resume.downloadCount += 1;
      resume.save();
      
      const pdfUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
      res.json({ 
        success: true, 
        pdfUrl,
        filename,
        template: template.name,
        message: 'PDF generated successfully'
      });
    });
    
    writeStream.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
    });
    
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
  }
});

// Bulk generate multiple template versions
router.post('/generate-multiple', authMiddleware, async (req, res) => {
  try {
    const { templateIds, options = {} } = req.body;
    
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'No resume found' });
    }
    
    const generatedFiles = [];
    
    for (const templateId of templateIds) {
      const template = templateService.getTemplateById(templateId);
      if (template) {
        const filename = `resume_${resume.userId}_${templateId}_${Date.now()}.pdf`;
        const filepath = path.join(uploadsDir, filename);
        
        const doc = await templateService.generatePDF(resume, templateId, options);
        const writeStream = fs.createWriteStream(filepath);
        doc.pipe(writeStream);
        doc.end();
        
        await new Promise((resolve) => {
          writeStream.on('finish', resolve);
        });
        
        generatedFiles.push({
          templateId,
          templateName: template.name,
          filename,
          url: `${req.protocol}://${req.get('host')}/uploads/${filename}`
        });
      }
    }
    
    res.json({
      success: true,
      count: generatedFiles.length,
      files: generatedFiles
    });
    
  } catch (error) {
    console.error('Bulk generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDFs' });
  }
});

// Save template preference
router.post('/save-template', authMiddleware, async (req, res) => {
  try {
    const { templateId } = req.body;
    
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    
    resume.templateId = templateId;
    
    // Add to saved templates if not already there
    if (!resume.savedTemplates.includes(templateId)) {
      resume.savedTemplates.push(templateId);
    }
    
    await resume.save();
    
    res.json({
      success: true,
      message: 'Template preference saved',
      currentTemplate: templateId,
      savedTemplates: resume.savedTemplates
    });
    
  } catch (error) {
    console.error('Error saving template:', error);
    res.status(500).json({ error: 'Failed to save template preference' });
  }
});

// Get template recommendations based on resume data
router.get('/template-recommendations', authMiddleware, async (req, res) => {
  try {
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    
    const recommendations = [];
    
    // Analyze resume to recommend templates
    if (resume.skills && resume.skills.some(skill => 
      ['react', 'node', 'python', 'javascript', 'java', 'aws'].includes(skill.toLowerCase())
    )) {
      recommendations.push(...templateService.getAllTemplates({ category: 'tech' }).slice(0, 3));
    }
    
    if (resume.experience && resume.experience.length >= 5) {
      recommendations.push(...templateService.getAllTemplates({ category: 'executive' }).slice(0, 2));
    }
    
    if (resume.projects && resume.projects.length > 0) {
      recommendations.push(...templateService.getAllTemplates({ category: 'creative' }).slice(0, 2));
    }
    
    if (resume.education && resume.education.length > 0 && resume.experience.length < 2) {
      recommendations.push(...templateService.getAllTemplates({ category: 'academic' }).slice(0, 2));
    }
    
    // Remove duplicates
    const unique = [...new Map(recommendations.map(item => [item.id, item])).values()];
    
    res.json({
      success: true,
      recommendations: unique.slice(0, 5)
    });
    
  } catch (error) {
    console.error('Error getting recommendations:', error);
    res.status(500).json({ error: 'Failed to get template recommendations' });
  }
});
// ==================== EXPORT OPTIONS ====================

router.get('/export/json', authMiddleware, async (req, res) => {
  try {
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }
    
    const exportData = {
      exportedAt: new Date(),
      version: '1.0',
      data: resume.toObject()
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=resume_${resume.fullName.replace(/\s/g, '_')}.json`);
    res.json(exportData);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export resume' });
  }
});

router.post('/import/json', authMiddleware, async (req, res) => {
  try {
    const { data } = req.body;
    
    if (!data || !data.fullName || !data.email) {
      return res.status(400).json({ error: 'Invalid resume data format' });
    }
    
    let resume = await Resume.findOne({ userId: req.userId });
    
    // Clean imported data
    const cleanedData = cleanResumeData(data);
    
    if (resume) {
      Object.assign(resume, cleanedData);
      await resume.save();
    } else {
      resume = new Resume({ ...cleanedData, userId: req.userId });
      await resume.save();
    }
    
    res.json({ success: true, message: 'Resume imported successfully', resume });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Failed to import resume', details: error.message });
  }
});


// ==================== AI MARKET INSIGHTS ====================

// AI Market Insights based on resume data
router.get('/market-insights', authMiddleware, async (req, res) => {
  try {
    const resume = await Resume.findOne({ userId: req.userId });
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Analyze resume to generate personalized insights
    const insights = generateMarketInsights(resume);
    
    res.json({
      success: true,
      insights
    });
  } catch (error) {
    console.error('Market insights error:', error);
    res.status(500).json({ error: 'Failed to generate market insights' });
  }
});

// Generate personalized market insights based on resume
function generateMarketInsights(resume) {
  const insights = {
    topJobRoles: [],
    skillGaps: [],
    salaryInsights: [],
    industryTrends: [],
    recommendations: [],
    marketDemand: [],
    careerPath: []
  };

  // Extract skills from resume
  const skills = resume.skills || [];
  const experience = resume.experience || [];
  const education = resume.education || [];
  const summary = resume.summary || '';
  
  // Analyze skills to determine job roles
  const jobRoleMapping = {
    'System Engineer': {
      skills: ['linux', 'python', 'aws', 'docker', 'kubernetes', 'bash', 'shell', 'system', 'network'],
      match: 0,
      salary: '$80,000 - $120,000',
      demand: 'High',
      trend: '+12%',
      description: 'System engineers are in high demand for infrastructure management'
    },
    'MERN Stack Developer': {
      skills: ['react', 'node.js', 'mongodb', 'express', 'javascript', 'redux', 'graphql'],
      match: 0,
      salary: '$70,000 - $110,000',
      demand: 'Very High',
      trend: '+15%',
      description: 'Full-stack MERN developers are highly sought after'
    },
    'DevOps Engineer': {
      skills: ['docker', 'kubernetes', 'jenkins', 'aws', 'terraform', 'ci/cd', 'linux', 'ansible'],
      match: 0,
      salary: '$90,000 - $140,000',
      demand: 'High',
      trend: '+18%',
      description: 'DevOps roles are growing rapidly with cloud adoption'
    },
    'Frontend Developer': {
      skills: ['react', 'angular', 'vue', 'javascript', 'html', 'css', 'typescript', 'next.js'],
      match: 0,
      salary: '$65,000 - $105,000',
      demand: 'High',
      trend: '+10%',
      description: 'Frontend development continues to evolve with new frameworks'
    },
    'Backend Developer': {
      skills: ['node.js', 'python', 'java', 'spring', 'django', 'api', 'microservices', 'sql'],
      match: 0,
      salary: '$75,000 - $115,000',
      demand: 'High',
      trend: '+11%',
      description: 'Backend developers are essential for scalable applications'
    },
    'Full Stack Developer': {
      skills: ['react', 'node.js', 'javascript', 'mongodb', 'express', 'html', 'css', 'sql'],
      match: 0,
      salary: '$80,000 - $125,000',
      demand: 'Very High',
      trend: '+14%',
      description: 'Full-stack versatility is highly valued'
    },
    'Data Scientist': {
      skills: ['python', 'sql', 'machine learning', 'tensorflow', 'pytorch', 'pandas', 'data analysis'],
      match: 0,
      salary: '$95,000 - $145,000',
      demand: 'High',
      trend: '+22%',
      description: 'Data science is one of the fastest-growing fields'
    },
    'Cloud Architect': {
      skills: ['aws', 'azure', 'gcp', 'cloud', 'terraform', 'kubernetes', 'docker', 'linux'],
      match: 0,
      salary: '$120,000 - $170,000',
      demand: 'High',
      trend: '+20%',
      description: 'Cloud architects command top salaries'
    },
    'Product Manager': {
      skills: ['agile', 'scrum', 'product', 'management', 'roadmap', 'analytics', 'user experience'],
      match: 0,
      salary: '$90,000 - $140,000',
      demand: 'Medium',
      trend: '+8%',
      description: 'Product managers bridge business and technology'
    },
    'AI/ML Engineer': {
      skills: ['python', 'machine learning', 'deep learning', 'tensorflow', 'pytorch', 'nlp', 'computer vision'],
      match: 0,
      salary: '$100,000 - $160,000',
      demand: 'Very High',
      trend: '+25%',
      description: 'AI/ML is transforming every industry'
    },
    'Cybersecurity Analyst': {
      skills: ['security', 'network security', 'firewall', 'penetration testing', 'compliance', 'risk assessment'],
      match: 0,
      salary: '$85,000 - $130,000',
      demand: 'High',
      trend: '+16%',
      description: 'Cybersecurity is critical for all organizations'
    },
    'Mobile Developer': {
      skills: ['react native', 'flutter', 'ios', 'android', 'swift', 'kotlin', 'mobile'],
      match: 0,
      salary: '$70,000 - $110,000',
      demand: 'Medium',
      trend: '+9%',
      description: 'Mobile development remains strong'
    },
    'Technical Lead': {
      skills: ['leadership', 'architecture', 'mentoring', 'project management', 'agile', 'system design'],
      match: 0,
      salary: '$110,000 - $160,000',
      demand: 'Medium',
      trend: '+10%',
      description: 'Tech leads combine technical skills with leadership'
    },
    'Database Administrator': {
      skills: ['sql', 'mongodb', 'postgresql', 'mysql', 'database', 'performance tuning', 'backup'],
      match: 0,
      salary: '$75,000 - $115,000',
      demand: 'Medium',
      trend: '+5%',
      description: 'Data management remains essential'
    },
    'QA Engineer': {
      skills: ['testing', 'automation', 'selenium', 'jest', 'cypress', 'quality assurance', 'bug tracking'],
      match: 0,
      salary: '$60,000 - $95,000',
      demand: 'Medium',
      trend: '+7%',
      description: 'Quality assurance is crucial for product reliability'
    }
  };

  // Calculate match scores for each job role
  for (const [role, data] of Object.entries(jobRoleMapping)) {
    let matchedSkills = 0;
    const lowerSkills = skills.map(s => s.toLowerCase());
    
    for (const requiredSkill of data.skills) {
      if (lowerSkills.some(skill => skill.includes(requiredSkill) || requiredSkill.includes(skill))) {
        matchedSkills++;
      }
    }
    
    // Calculate match percentage
    const matchPercentage = Math.min(Math.round((matchedSkills / data.skills.length) * 100), 100);
    data.match = matchPercentage;
    
    // Add to top job roles if match > 30%
    if (matchPercentage > 30) {
      insights.topJobRoles.push({
        title: role,
        match: matchPercentage,
        salary: data.salary,
        demand: data.demand,
        trend: data.trend,
        description: data.description,
        requiredSkills: data.skills.slice(0, 5),
        matchedSkills: matchedSkills,
        totalRequired: data.skills.length
      });
    }
  }

  // Sort by match percentage (highest first)
  insights.topJobRoles.sort((a, b) => b.match - a.match);
  
  // Get top 5 roles
  insights.topJobRoles = insights.topJobRoles.slice(0, 5);

  // Identify skill gaps for the top job role
  if (insights.topJobRoles.length > 0) {
    const topRole = insights.topJobRoles[0];
    const jobRoleConfig = jobRoleMapping[topRole.title];
    const lowerSkills = skills.map(s => s.toLowerCase());
    
    for (const requiredSkill of jobRoleConfig.skills) {
      const hasSkill = lowerSkills.some(skill => skill.includes(requiredSkill) || requiredSkill.includes(skill));
      if (!hasSkill) {
        insights.skillGaps.push({
          skill: requiredSkill.charAt(0).toUpperCase() + requiredSkill.slice(1),
          importance: 'High',
          suggestion: `Learn ${requiredSkill} to increase your match for ${topRole.title} roles`,
          estimatedTimeToLearn: getEstimatedLearningTime(requiredSkill),
          resources: getLearningResources(requiredSkill)
        });
      }
    }
    insights.skillGaps = insights.skillGaps.slice(0, 5);
  }

  // Generate salary insights based on experience
  const experienceLevel = getExperienceLevel(experience);
  const baseSalary = getBaseSalaryByExperience(experienceLevel);
  
  insights.salaryInsights = [
    {
      title: 'Current Market Range',
      min: baseSalary.min,
      max: baseSalary.max,
      currency: 'USD',
      percentile: '50th',
      description: `Based on ${experienceLevel} level positions in current market`
    },
    {
      title: 'With Skill Upgrades',
      min: Math.round(baseSalary.min * 1.2),
      max: Math.round(baseSalary.max * 1.3),
      currency: 'USD',
      percentile: '75th',
      description: 'Potential salary after acquiring recommended skills'
    },
    {
      title: 'Top Tier Potential',
      min: Math.round(baseSalary.min * 1.4),
      max: Math.round(baseSalary.max * 1.6),
      currency: 'USD',
      percentile: '90th',
      description: 'Top performers with in-demand skills can earn significantly more'
    }
  ];

  // Industry trends based on skills
  const industries = extractIndustriesFromSkills(skills);
  insights.industryTrends = industries.map(industry => ({
    name: industry.name,
    growth: industry.growth,
    demand: industry.demand,
    topSkills: industry.topSkills,
    description: industry.description
  }));

  // Market demand analysis
  insights.marketDemand = generateMarketDemand(insights.topJobRoles, skills);

  // Career path recommendations
  insights.careerPath = generateCareerPath(insights.topJobRoles, experienceLevel, skills);

  // Personalized recommendations
  insights.recommendations = generatePersonalizedRecommendations(resume, insights);

  return insights;
}

// Helper functions
function getExperienceLevel(experience) {
  const totalYears = experience.reduce((total, exp) => {
    if (exp.startDate && exp.endDate && exp.endDate !== 'Present') {
      const start = new Date(exp.startDate);
      const end = new Date(exp.endDate);
      const years = (end - start) / (1000 * 60 * 60 * 24 * 365);
      return total + years;
    }
    return total;
  }, 0);
  
  if (totalYears < 1) return 'Entry';
  if (totalYears < 3) return 'Junior';
  if (totalYears < 6) return 'Mid';
  if (totalYears < 10) return 'Senior';
  return 'Lead/Executive';
}

function getBaseSalaryByExperience(level) {
  const salaries = {
    'Entry': { min: 50000, max: 70000 },
    'Junior': { min: 65000, max: 85000 },
    'Mid': { min: 80000, max: 110000 },
    'Senior': { min: 100000, max: 140000 },
    'Lead/Executive': { min: 120000, max: 180000 }
  };
  return salaries[level] || salaries['Mid'];
}

function getEstimatedLearningTime(skill) {
  const times = {
    'react': '2-3 months',
    'node.js': '2-3 months',
    'python': '1-2 months',
    'docker': '1-2 weeks',
    'kubernetes': '1-2 months',
    'aws': '2-3 months',
    'javascript': '2-3 months',
    'typescript': '1-2 months',
    'graphql': '2-3 weeks',
    'mongodb': '2-3 weeks',
    'sql': '1-2 months',
    'git': '1-2 weeks',
    'linux': '1-2 months'
  };
  return times[skill.toLowerCase()] || '2-4 weeks';
}

function getLearningResources(skill) {
  const resources = {
    'react': ['React Official Docs', 'Udemy - React Complete Guide', 'freeCodeCamp React Course'],
    'node.js': ['Node.js Official Docs', 'Node.js Design Patterns Book', 'YouTube - Node.js Crash Course'],
    'python': ['Python Official Tutorial', 'Coursera - Python for Everybody', 'Codecademy Python Course'],
    'docker': ['Docker Official Docs', 'Docker Deep Dive Book', 'KodeKloud Docker Course'],
    'kubernetes': ['Kubernetes Official Docs', 'Kubernetes in Action Book', 'KodeKloud Kubernetes Course'],
    'aws': ['AWS Training & Certification', 'AWS Certified Solutions Architect Book', 'A Cloud Guru Courses'],
    'javascript': ['JavaScript.info', 'You Dont Know JS Book Series', 'freeCodeCamp JavaScript Course']
  };
  return resources[skill.toLowerCase()] || ['Online tutorials', 'Official documentation', 'Practice projects'];
}

function extractIndustriesFromSkills(skills) {
  const allIndustries = {
    'Tech': { growth: '+15%', demand: 'High', topSkills: ['React', 'Node.js', 'Python', 'AWS'], description: 'Technology sector continues rapid growth' },
    'Finance': { growth: '+8%', demand: 'Medium', topSkills: ['SQL', 'Python', 'Excel', 'Analytics'], description: 'Fintech is revolutionizing financial services' },
    'Healthcare': { growth: '+12%', demand: 'High', topSkills: ['Data Analysis', 'Python', 'Compliance', 'Security'], description: 'Health tech is expanding rapidly' },
    'E-commerce': { growth: '+10%', demand: 'Medium', topSkills: ['React', 'Node.js', 'Payment Integration', 'Security'], description: 'Online retail continues to grow' },
    'AI/ML': { growth: '+25%', demand: 'Very High', topSkills: ['Python', 'TensorFlow', 'PyTorch', 'Data Science'], description: 'AI is transforming every industry' },
    'Cloud Computing': { growth: '+20%', demand: 'High', topSkills: ['AWS', 'Azure', 'Docker', 'Kubernetes'], description: 'Cloud adoption is accelerating' }
  };
  
  const lowerSkills = skills.map(s => s.toLowerCase());
  const matchedIndustries = [];
  
  for (const [industry, data] of Object.entries(allIndustries)) {
    const matches = data.topSkills.some(skill => 
      lowerSkills.some(userSkill => userSkill.includes(skill.toLowerCase()))
    );
    if (matches) {
      matchedIndustries.push({ name: industry, ...data });
    }
  }
  
  return matchedIndustries.length > 0 ? matchedIndustries.slice(0, 3) : [{ name: 'General Tech', ...allIndustries.Tech }];
}

function generateMarketDemand(topJobRoles, skills) {
  const demand = [];
  
  for (const role of topJobRoles.slice(0, 3)) {
    demand.push({
      role: role.title,
      demandLevel: role.demand,
      trend: role.trend,
      numberOfJobs: getJobCountEstimate(role.title),
      topLocations: ['New York', 'San Francisco', 'Austin', 'Seattle', 'Remote'],
      competition: getCompetitionLevel(role.match)
    });
  }
  
  return demand;
}

function getJobCountEstimate(role) {
  const estimates = {
    'MERN Stack Developer': '15,000+',
    'Full Stack Developer': '25,000+',
    'Frontend Developer': '18,000+',
    'Backend Developer': '20,000+',
    'DevOps Engineer': '12,000+',
    'Data Scientist': '10,000+',
    'Cloud Architect': '8,000+',
    'System Engineer': '12,000+'
  };
  return estimates[role] || '5,000+';
}

function getCompetitionLevel(matchScore) {
  if (matchScore > 70) return 'Low';
  if (matchScore > 50) return 'Medium';
  return 'High';
}

function generateCareerPath(topJobRoles, experienceLevel, skills) {
  const path = [];
  
  if (topJobRoles.length > 0) {
    const currentRole = topJobRoles[0];
    
    path.push({
      stage: 'Current Position',
      role: 'Based on your skills',
      timeframe: 'Now',
      skills: skills.slice(0, 5)
    });
    
    if (experienceLevel === 'Entry' || experienceLevel === 'Junior') {
      path.push({
        stage: 'Next Step',
        role: currentRole.title,
        timeframe: '1-2 years',
        skills: currentRole.requiredSkills || [],
        description: `Build experience as a ${currentRole.title}`
      });
      
      path.push({
        stage: 'Career Growth',
        role: `Senior ${currentRole.title}`,
        timeframe: '3-5 years',
        skills: ['Leadership', 'Architecture', 'Mentoring', ...currentRole.requiredSkills?.slice(0, 3) || []],
        description: 'Move into senior role with team leadership'
      });
    } else if (experienceLevel === 'Mid') {
      path.push({
        stage: 'Advancement',
        role: `Senior ${currentRole.title}`,
        timeframe: '1-2 years',
        skills: ['System Design', 'Architecture', 'Team Leadership'],
        description: 'Progress to senior technical role'
      });
      
      path.push({
        stage: 'Leadership',
        role: 'Technical Lead',
        timeframe: '3-4 years',
        skills: ['Project Management', 'Mentoring', 'Strategic Planning'],
        description: 'Move into technical leadership'
      });
    } else {
      path.push({
        stage: 'Leadership Path',
        role: 'Technical Lead / Architect',
        timeframe: '1-2 years',
        skills: ['System Architecture', 'Team Management', 'Strategic Planning'],
        description: 'Lead technical initiatives'
      });
      
      path.push({
        stage: 'Executive Path',
        role: 'Engineering Manager / CTO',
        timeframe: '3-5 years',
        skills: ['Executive Leadership', 'Business Strategy', 'Product Vision'],
        description: 'Move into executive leadership'
      });
    }
  }
  
  return path;
}

function generatePersonalizedRecommendations(resume, insights) {
  const recommendations = [];
  
  // Skill-based recommendations
  if (insights.skillGaps.length > 0) {
    recommendations.push({
      type: 'skill',
      priority: 'high',
      message: `Learn ${insights.skillGaps[0].skill} to increase job opportunities`,
      action: insights.skillGaps[0].suggestion,
      estimatedTime: insights.skillGaps[0].estimatedTimeToLearn
    });
  }
  
  // Experience recommendations
  if (resume.experience.length < 2) {
    recommendations.push({
      type: 'experience',
      priority: 'high',
      message: 'Add more work experience to strengthen your profile',
      action: 'Include internships, freelance work, or personal projects',
      estimatedTime: 'Ongoing'
    });
  }
  
  // Project recommendations
  if (resume.projects.length < 2) {
    recommendations.push({
      type: 'project',
      priority: 'medium',
      message: 'Showcase your skills with portfolio projects',
      action: 'Build and deploy projects demonstrating your technical abilities',
      estimatedTime: '2-4 weeks'
    });
  }
  
  // Certification recommendations
  if (resume.certifications.length === 0 && insights.topJobRoles.length > 0) {
    const topRole = insights.topJobRoles[0];
    recommendations.push({
      type: 'certification',
      priority: 'medium',
      message: `Get certified to stand out for ${topRole.title} roles`,
      action: getCertificationSuggestion(topRole.title),
      estimatedTime: '1-3 months'
    });
  }
  
  // Summary improvement
  if (!resume.summary || resume.summary.length < 100) {
    recommendations.push({
      type: 'summary',
      priority: 'high',
      message: 'Write a compelling professional summary',
      action: 'Highlight your key achievements and career goals',
      estimatedTime: '30 minutes'
    });
  }
  
  return recommendations;
}

function getCertificationSuggestion(role) {
  const certifications = {
    'MERN Stack Developer': 'MERN Stack Certification from Coursera or edX',
    'DevOps Engineer': 'AWS Certified DevOps Engineer or Kubernetes Certification',
    'Cloud Architect': 'AWS Solutions Architect or Azure Solutions Architect',
    'Data Scientist': 'Google Professional Data Engineer or IBM Data Science',
    'System Engineer': 'Linux Professional Institute Certification (LPIC)',
    'Frontend Developer': 'Meta Frontend Developer Professional Certificate',
    'Backend Developer': 'Node.js Certified Developer or Spring Professional'
  };
  return certifications[role] || 'Industry-recognized certification in your field';
}
module.exports = router;