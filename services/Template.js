const Template = require('../models/Template');
const templatesData = require('../data/Template');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

class TemplateService {
  constructor() {
    this.templates = new Map();
    this.initTemplates();
  }

  async initTemplates() {
    try {
      for (const template of templatesData) {
        // Ensure template has all required properties
        const enrichedTemplate = {
          ...template,
          fonts: template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' },
          layout: template.layout || 'single-column',
          isActive: template.isActive !== undefined ? template.isActive : true,
          popularity: template.popularity || 0
        };
        this.templates.set(template.id, enrichedTemplate);
        
        // Sync with database (optional) - FIXED: Removed deprecated 'new' option
        try {
          await Template.findOneAndUpdate(
            { id: template.id },
            enrichedTemplate,
            { upsert: true, returnDocument: 'after' } // Changed from 'new: true' to 'returnDocument: "after"'
          );
        } catch (dbError) {
          // Silent fail for DB sync - don't spam console
          // console.error('Error syncing template to DB:', dbError.message);
        }
      }
      // Single clear console log instead of multiple
      console.log(`✅ Initialized ${this.templates.size} templates`);
    } catch (error) {
      console.error('Error initializing templates:', error);
    }
  }

  getAllTemplates(filters = {}) {
    let templates = Array.from(this.templates.values());
    
    if (filters.category && filters.category !== 'all') {
      templates = templates.filter(t => t.category === filters.category);
    }
    if (filters.industry) {
      templates = templates.filter(t => t.industries && t.industries.includes(filters.industry));
    }
    if (filters.experienceLevel) {
      templates = templates.filter(t => t.experienceLevel && t.experienceLevel.includes(filters.experienceLevel));
    }
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      templates = templates.filter(t => 
        (t.name && t.name.toLowerCase().includes(searchLower)) ||
        (t.description && t.description.toLowerCase().includes(searchLower))
      );
    }
    
    templates.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    
    return templates;
  }

  getTemplateById(id) {
    const template = this.templates.get(id);
    if (!template) return null;
    
    return {
      ...template,
      fonts: template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' }
    };
  }

  getTemplatesByCategory(category) {
    return Array.from(this.templates.values())
      .filter(t => t.category === category)
      .map(t => ({
        ...t,
        fonts: t.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' }
      }));
  }

  async generatePDF(resume, templateId, options = {}) {
    const template = this.getTemplateById(templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    const doc = new PDFDocument({
      margin: options.margin || 50,
      size: options.size || 'A4',
      info: {
        Title: `${resume.fullName || 'Resume'} - Resume`,
        Author: resume.fullName || 'User',
        Subject: 'Professional Resume',
        Keywords: 'resume, cv, professional'
      }
    });

    const renderMethod = this.getRenderMethod(template.category);
    await renderMethod.call(this, doc, resume, template, options);

    return doc;
  }

  getRenderMethod(category) {
    const methods = {
      'modern': this.renderModernTemplate,
      'classic': this.renderClassicTemplate,
      'creative': this.renderCreativeTemplate,
      'professional': this.renderProfessionalTemplate,
      'minimal': this.renderMinimalTemplate,
      'executive': this.renderExecutiveTemplate,
      'tech': this.renderTechTemplate,
      'academic': this.renderAcademicTemplate
    };
    return methods[category] || this.renderModernTemplate;
  }

  async renderModernTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#4f46e5';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.rect(0, 0, doc.page.width, 160).fill(primaryColor);
    
    doc.fillColor('#ffffff')
      .fontSize(32)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 45);
    
    if (resume.summary) {
      const headline = resume.summary.split('.')[0].substring(0, 100);
      doc.fontSize(14)
        .font(fonts.body)
        .text(headline, 50, 90, { width: doc.page.width - 100 });
    }
    
    doc.fontSize(10)
      .font(fonts.body)
      .text(`${resume.email || ''}${resume.email && resume.phone ? ' | ' : ''}${resume.phone || ''}`, 50, 125);
    
    let yPos = 190;
    
    if (resume.summary) {
      doc.fillColor('#1e293b')
        .fontSize(18)
        .font(fonts.heading)
        .text('Professional Summary', 50, yPos);
      
      yPos += 25;
      doc.fontSize(11)
        .font(fonts.body)
        .text(resume.summary, 50, yPos, {
          width: doc.page.width - 100,
          align: 'justify',
          lineGap: 4
        });
      
      yPos += doc.heightOfString(resume.summary, { width: doc.page.width - 100 }) + 20;
    }
    
    if (resume.experience && resume.experience.length > 0) {
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.fillColor('#1e293b')
        .fontSize(18)
        .font(fonts.heading)
        .text('Work Experience', 50, yPos);
      
      yPos += 25;
      
      for (const exp of resume.experience) {
        if (yPos > 750) {
          doc.addPage();
          yPos = 50;
        }
        
        doc.fillColor(primaryColor)
          .fontSize(14)
          .font(fonts.heading)
          .text(exp.title || '', 50, yPos);
        
        doc.fillColor('#64748b')
          .fontSize(11)
          .font(fonts.body)
          .text(`${exp.company || ''} | ${exp.startDate || ''} - ${exp.endDate || 'Present'}`, 50, yPos + 18);
        
        const description = exp.desc || exp.description || '';
        if (description) {
          doc.fillColor('#334155')
            .fontSize(10)
            .font(fonts.body)
            .text(description, 50, yPos + 35, {
              width: doc.page.width - 100,
              lineGap: 3
            });
          yPos += 55 + doc.heightOfString(description, { width: doc.page.width - 100 });
        } else {
          yPos += 40;
        }
        
        yPos += 10;
      }
    }
    
    if (resume.education && resume.education.length > 0) {
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.fillColor('#1e293b')
        .fontSize(18)
        .font(fonts.heading)
        .text('Education', 50, yPos);
      
      yPos += 25;
      
      for (const edu of resume.education) {
        if (yPos > 750) {
          doc.addPage();
          yPos = 50;
        }
        
        doc.fillColor(primaryColor)
          .fontSize(13)
          .font(fonts.heading)
          .text(edu.degree || '', 50, yPos);
        
        doc.fillColor('#64748b')
          .fontSize(11)
          .font(fonts.body)
          .text(`${edu.school || ''} | ${edu.startDate || ''} - ${edu.endDate || ''}`, 50, yPos + 18);
        
        if (edu.description) {
          doc.fillColor('#334155')
            .fontSize(10)
            .font(fonts.body)
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
    
    if (resume.skills && resume.skills.length > 0) {
      if (yPos > 750) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.fillColor('#1e293b')
        .fontSize(18)
        .font(fonts.heading)
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
          .font(fonts.body)
          .text(`• ${skill}`, x, y, { width: skillWidth - 10 });
      });
    }
  }

  async renderClassicTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#1e293b';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.fillColor(primaryColor);
    
    doc.fontSize(28)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 50, { align: 'center' });
    
    doc.fontSize(11)
      .font(fonts.body)
      .text(`${resume.email || ''} | ${resume.phone || ''}`, 50, 90, { align: 'center' });
    
    doc.moveTo(50, 130).lineTo(doc.page.width - 50, 130).stroke();
    
    let yPos = 150;
    
    if (resume.summary) {
      doc.fontSize(14).font(fonts.heading).text('SUMMARY', 50, yPos);
      doc.fontSize(10).font(fonts.body).text(resume.summary, 50, yPos + 20, {
        width: doc.page.width - 100,
        align: 'justify'
      });
      yPos += 50 + doc.heightOfString(resume.summary, { width: doc.page.width - 100 });
    }
    
    if (resume.experience && resume.experience.length > 0) {
      doc.fontSize(14).font(fonts.heading).text('EXPERIENCE', 50, yPos);
      yPos += 25;
      
      for (const exp of resume.experience) {
        doc.fontSize(11).font(fonts.heading).text(exp.title || '', 50, yPos);
        doc.fontSize(10).font(fonts.body).text(`${exp.company || ''} (${exp.startDate || ''} - ${exp.endDate || 'Present'})`, 50, yPos + 15);
        
        const description = exp.desc || exp.description || '';
        if (description) {
          doc.fontSize(9).font(fonts.body).text(description, 50, yPos + 30, {
            width: doc.page.width - 100
          });
          yPos += 55 + doc.heightOfString(description, { width: doc.page.width - 100 });
        } else {
          yPos += 35;
        }
        yPos += 10;
      }
    }
    
    if (resume.education && resume.education.length > 0) {
      doc.fontSize(14).font(fonts.heading).text('EDUCATION', 50, yPos);
      yPos += 25;
      
      for (const edu of resume.education) {
        doc.fontSize(11).font(fonts.heading).text(edu.degree || '', 50, yPos);
        doc.fontSize(10).font(fonts.body).text(`${edu.school || ''} (${edu.startDate || ''} - ${edu.endDate || ''})`, 50, yPos + 15);
        yPos += 40;
      }
    }
  }

  async renderCreativeTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#ec4899';
    const secondaryColor = (template.colors && template.colors[1]) || '#f43f5e';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.rect(0, 0, doc.page.width, 200).fill(primaryColor);
    doc.circle(doc.page.width - 50, 50, 80).fill(secondaryColor);
    doc.circle(50, 150, 60).fill(secondaryColor);
    
    doc.fillColor('#ffffff')
      .fontSize(36)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 60);
    
    if (resume.summary) {
      doc.fontSize(12)
        .font(fonts.body)
        .text(resume.summary.substring(0, 150), 50, 110, {
          width: doc.page.width - 100
        });
    }
    
    let yPos = 230;
    const leftCol = 50;
    
    doc.fillColor(primaryColor)
      .fontSize(16)
      .font(fonts.heading)
      .text('Contact', leftCol, yPos);
    
    yPos += 25;
    doc.fillColor('#334155')
      .fontSize(10)
      .font(fonts.body)
      .text(resume.email || '', leftCol, yPos);
    yPos += 18;
    doc.text(resume.phone || '', leftCol, yPos);
    yPos += 25;
    
    if (resume.skills && resume.skills.length > 0) {
      doc.fillColor(primaryColor)
        .fontSize(16)
        .font(fonts.heading)
        .text('Skills', leftCol, yPos);
      
      yPos += 25;
      resume.skills.forEach(skill => {
        doc.fillColor('#475569')
          .fontSize(10)
          .font(fonts.body)
          .text(`✦ ${skill}`, leftCol, yPos);
        yPos += 18;
      });
    }
  }

  async renderProfessionalTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#1e3a8a';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    const leftColWidth = 120;
    const rightColX = leftColWidth + 30;
    
    doc.rect(0, 0, leftColWidth + 20, doc.page.height).fill('#f8fafc');
    
    doc.fillColor(primaryColor);
    doc.fontSize(12).font(fonts.heading).text('CONTACT', 30, 50);
    
    doc.fontSize(9).font(fonts.body);
    let yPos = 75;
    doc.text(resume.email || '', 30, yPos);
    yPos += 20;
    doc.text(resume.phone || '', 30, yPos);
    yPos += 25;
    
    if (resume.skills && resume.skills.length > 0) {
      doc.fontSize(12).font(fonts.heading).text('SKILLS', 30, yPos);
      yPos += 20;
      
      resume.skills.forEach(skill => {
        doc.fontSize(9).font(fonts.body).text(`• ${skill}`, 30, yPos);
        yPos += 18;
      });
    }
    
    doc.fillColor(primaryColor);
    doc.fontSize(26).font(fonts.heading).text(resume.fullName || 'Your Name', rightColX, 50);
    
    let rightY = 130;
    
    if (resume.summary) {
      doc.fillColor(primaryColor);
      doc.fontSize(12).font(fonts.heading).text('PROFILE', rightColX, rightY);
      rightY += 20;
      doc.fillColor('#475569');
      doc.fontSize(9).font(fonts.body).text(resume.summary, rightColX, rightY, {
        width: doc.page.width - rightColX - 50,
        align: 'justify'
      });
      rightY += doc.heightOfString(resume.summary, { width: doc.page.width - rightColX - 50 }) + 20;
    }
    
    if (resume.experience && resume.experience.length > 0) {
      doc.fillColor(primaryColor);
      doc.fontSize(12).font(fonts.heading).text('WORK EXPERIENCE', rightColX, rightY);
      rightY += 25;
      
      for (const exp of resume.experience) {
        doc.fillColor('#1e293b');
        doc.fontSize(10).font(fonts.heading).text(exp.title || '', rightColX, rightY);
        doc.fillColor('#64748b');
        doc.fontSize(9).font(fonts.body).text(`${exp.company || ''} | ${exp.startDate || ''} - ${exp.endDate || 'Present'}`, rightColX, rightY + 13);
        
        const description = exp.desc || exp.description || '';
        if (description) {
          doc.fillColor('#475569');
          doc.fontSize(8).font(fonts.body).text(description, rightColX, rightY + 28, {
            width: doc.page.width - rightColX - 50
          });
          rightY += 50 + doc.heightOfString(description, { width: doc.page.width - rightColX - 50 });
        } else {
          rightY += 35;
        }
        rightY += 10;
      }
    }
  }

  async renderMinimalTemplate(doc, resume, template, options) {
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.fillColor('#1e293b');
    doc.fontSize(24)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 50);
    
    doc.fontSize(10)
      .font(fonts.body)
      .text(`${resume.email || ''} | ${resume.phone || ''}`, 50, 85);
    
    let yPos = 130;
    
    if (resume.summary) {
      doc.fontSize(10)
        .font(fonts.body)
        .text(resume.summary, 50, yPos, {
          width: doc.page.width - 100,
          align: 'justify',
          lineHeight: 1.5
        });
      yPos += doc.heightOfString(resume.summary, { width: doc.page.width - 100 }) + 30;
    }
    
    if (resume.experience && resume.experience.length > 0) {
      doc.fontSize(12)
        .font(fonts.heading)
        .text('Experience', 50, yPos);
      yPos += 20;
      
      for (const exp of resume.experience) {
        doc.fontSize(10)
          .font(fonts.heading)
          .text(exp.title || '', 50, yPos);
        doc.fontSize(9)
          .font(fonts.body)
          .text(`${exp.company || ''} | ${exp.startDate || ''} - ${exp.endDate || 'Present'}`, 50, yPos + 13);
        
        const description = exp.desc || exp.description || '';
        if (description) {
          doc.fontSize(9)
            .font(fonts.body)
            .text(description, 50, yPos + 28, {
              width: doc.page.width - 100
            });
          yPos += 55 + doc.heightOfString(description, { width: doc.page.width - 100 });
        } else {
          yPos += 40;
        }
        yPos += 10;
      }
    }
  }

  async renderExecutiveTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#0f172a';
    const accentColor = (template.colors && template.colors[1]) || '#475569';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.rect(0, 0, doc.page.width, 120).fill(primaryColor);
    
    doc.fillColor('#ffffff')
      .fontSize(34)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 40);
    
    if (resume.summary) {
      const executiveTitle = resume.summary.split('.')[0].substring(0, 80);
      doc.fontSize(12)
        .font(fonts.body)
        .text(executiveTitle, 50, 85);
    }
    
    doc.rect(0, 120, doc.page.width, 40).fill(accentColor);
    doc.fillColor('#ffffff')
      .fontSize(9)
      .font(fonts.body)
      .text(`${resume.email || ''}  |  ${resume.phone || ''}`, 50, 135);
    
    let yPos = 190;
    
    if (resume.summary) {
      doc.fillColor(primaryColor)
        .fontSize(14)
        .font(fonts.heading)
        .text('Executive Summary', 50, yPos);
      
      yPos += 20;
      doc.fillColor('#334155')
        .fontSize(10)
        .font(fonts.body)
        .text(resume.summary, 50, yPos, {
          width: doc.page.width - 100,
          align: 'justify'
        });
    }
  }

  async renderTechTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#06b6d4';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.rect(0, 0, doc.page.width, 140).fill(primaryColor);
    
    doc.fillColor('#ffffff')
      .fontSize(30)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 45);
    
    doc.fontSize(9)
      .font(fonts.body)
      .text(`${resume.email || ''}  •  ${resume.phone || ''}`, 50, 115);
    
    let yPos = 170;
    
    if (resume.skills && resume.skills.length > 0) {
      doc.fillColor(primaryColor)
        .fontSize(16)
        .font(fonts.heading)
        .text('Technical Toolkit', 50, yPos);
      
      yPos += 25;
      
      const skillsPerRow = 4;
      const skillWidth = (doc.page.width - 100) / skillsPerRow;
      
      resume.skills.forEach((skill, index) => {
        const col = index % skillsPerRow;
        const row = Math.floor(index / skillsPerRow);
        const x = 50 + (col * skillWidth);
        const y = yPos + (row * 28);
        
        doc.fillColor(primaryColor + '15')
          .rect(x, y, skillWidth - 10, 22)
          .fill();
        doc.fillColor(primaryColor)
          .fontSize(9)
          .font(fonts.body)
          .text(skill, x + 5, y + 6);
      });
    }
  }

  async renderAcademicTemplate(doc, resume, template, options) {
    const primaryColor = (template.colors && template.colors[0]) || '#1e293b';
    const fonts = template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' };
    
    doc.fillColor(primaryColor);
    
    doc.fontSize(26)
      .font(fonts.heading)
      .text(resume.fullName || 'Your Name', 50, 50, { align: 'center' });
    
    doc.fontSize(11)
      .font(fonts.body)
      .text(resume.email || '', 50, 85, { align: 'center' });
    
    doc.moveTo(50, 110).lineTo(doc.page.width - 50, 110).stroke();
    
    let yPos = 130;
    
    if (resume.summary) {
      doc.fontSize(12).font(fonts.heading).text('Research Summary', 50, yPos);
      yPos += 20;
      doc.fontSize(10).font(fonts.body).text(resume.summary, 50, yPos, {
        width: doc.page.width - 100,
        align: 'justify'
      });
      yPos += doc.heightOfString(resume.summary, { width: doc.page.width - 100 }) + 25;
    }
    
    if (resume.education && resume.education.length > 0) {
      doc.fontSize(12).font(fonts.heading).text('Education', 50, yPos);
      yPos += 25;
      
      for (const edu of resume.education) {
        doc.fontSize(11).font(fonts.heading).text(edu.degree || '', 50, yPos);
        doc.fontSize(10).font(fonts.body).text(edu.school || '', 50, yPos + 15);
        doc.fontSize(9).font(fonts.body).text(`${edu.startDate || ''} - ${edu.endDate || 'Present'}`, 50, yPos + 28);
        yPos += 55;
        yPos += 10;
      }
    }
  }
}

module.exports = new TemplateService();