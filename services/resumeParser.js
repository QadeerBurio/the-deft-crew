// services/resumeParser.js
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');

/**
 * Extract text from PDF file
 */
const extractTextFromPDF = async (filePath) => {
  try {
    console.log('📄 Extracting text from PDF...');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    const text = data.text || '';
    console.log(`✅ Extracted ${text.length} characters from PDF`);
    return text;
  } catch (error) {
    console.error('❌ PDF extraction error:', error);
    throw new Error('Failed to extract text from PDF: ' + error.message);
  }
};

/**
 * Extract text from Word document
 */
const extractTextFromWord = async (filePath) => {
  try {
    console.log('📄 Extracting text from Word document...');
    const dataBuffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    const text = result.value || '';
    console.log(`✅ Extracted ${text.length} characters from Word document`);
    return text;
  } catch (error) {
    console.error('❌ Word extraction error:', error);
    throw new Error('Failed to extract text from Word document: ' + error.message);
  }
};

/**
 * Parse personal information from text
 */
const parsePersonalInfo = (text) => {
  console.log('🔍 Parsing personal information...');
  
  const lines = text.split('\n').filter(line => line.trim());
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const phoneRegex = /(\+\d{1,3}[-.]?)?\(?\d{3}\)?[-.]?\d{3}[-.]?\d{4}/;
  const linkedinRegex = /linkedin\.com\/in\/[a-zA-Z0-9-]+/;
  const githubRegex = /github\.com\/[a-zA-Z0-9-]+/;
  
  let email = text.match(emailRegex)?.[0] || '';
  let phone = text.match(phoneRegex)?.[0] || '';
  let linkedin = text.match(linkedinRegex)?.[0] || '';
  let github = text.match(githubRegex)?.[0] || '';
  
  // Try to find name (usually first 1-3 lines)
  let firstName = '';
  let lastName = '';
  let address = '';
  let city = '';
  let state = '';
  let country = '';
  let postalCode = '';

  // Clean lines and find name
  const cleanLines = lines.filter(line => {
    const l = line.trim();
    return l.length > 0 && 
           !l.match(emailRegex) && 
           !l.match(phoneRegex) &&
           !l.match(linkedinRegex) &&
           !l.match(githubRegex);
  });

  // Try to find name (first line that looks like a name)
  for (const line of cleanLines) {
    const words = line.split(' ').filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 4) {
      // Check if it looks like a name (contains letters only)
      const isName = words.every(w => /^[A-Za-z\-']+$/.test(w));
      if (isName && !firstName) {
        firstName = words[0] || '';
        lastName = words.slice(1).join(' ') || '';
        console.log(`👤 Found name: ${firstName} ${lastName}`);
        break;
      }
    }
  }

  // Try to find address
  const addressRegex = /(\d{1,5}\s\w+\s\w+[\s\w,]*)/;
  const addressMatch = text.match(addressRegex);
  if (addressMatch) {
    address = addressMatch[0] || '';
    console.log(`📍 Found address: ${address}`);
  }

  const result = {
    firstName,
    lastName,
    email,
    phone,
    linkedin,
    github,
    address,
    city,
    state,
    country,
    postalCode
  };
  
  console.log('✅ Personal info parsed:', result);
  return result;
};

/**
 * Parse education from text
 */
const parseEducation = (text) => {
  console.log('🔍 Parsing education...');
  
  const education = [];
  const educationKeywords = [
    'university', 'college', 'institute', 'school', 
    'bachelor', 'master', 'phd', 'b.s', 'm.s', 'b.a', 'm.a',
    'bsc', 'msc', 'phd', 'btech', 'mtech', 'bcom', 'mcom',
    'degree', 'diploma', 'certificate'
  ];
  
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  let currentEducation = null;
  let foundEducation = false;
  let educationSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();

    // Check if this line contains education keywords
    const isEducationLine = educationKeywords.some(keyword => lowerLine.includes(keyword));

    if (isEducationLine && !foundEducation) {
      // If we were already building an education, save it
      if (currentEducation && currentEducation.institution) {
        education.push(currentEducation);
      }

      foundEducation = true;
      educationSectionStarted = true;
      
      currentEducation = {
        institution: line,
        degree: '',
        fieldOfStudy: '',
        startDate: null,
        endDate: null,
        current: false,
        gpa: null,
        description: ''
      };

      // Try to extract degree from the same line
      const degreeMatch = line.match(/(Bachelor|Master|PhD|B\.S|M\.S|B\.A|M\.A|BSc|MSc|BTech|MTech|BCom|MCom|MBA|BBA|BFA|MFA)/i);
      if (degreeMatch) {
        currentEducation.degree = degreeMatch[0];
        // Remove degree from institution
        currentEducation.institution = line.replace(degreeMatch[0], '').trim();
        console.log(`🎓 Found degree: ${currentEducation.degree}`);
      }

      // Try to find dates
      const dateRegex = /\b(19|20)\d{2}\b/g;
      const dates = line.match(dateRegex);
      if (dates && dates.length >= 2) {
        currentEducation.startDate = new Date(parseInt(dates[0]), 0, 1);
        currentEducation.endDate = new Date(parseInt(dates[1]), 0, 1);
        console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
      } else if (dates && dates.length === 1) {
        currentEducation.startDate = new Date(parseInt(dates[0]), 0, 1);
        console.log(`📅 Found start date: ${dates[0]}`);
      }

      // Check for "present" or "current"
      if (lowerLine.includes('present') || lowerLine.includes('current')) {
        currentEducation.current = true;
        console.log('🔄 Currently studying');
      }

    } else if (foundEducation && currentEducation) {
      // If we're in education section, try to parse more details
      if (!currentEducation.fieldOfStudy && 
          line.length > 2 && 
          !educationKeywords.some(k => lowerLine.includes(k))) {
        currentEducation.fieldOfStudy = line;
        console.log(`📚 Found field of study: ${line}`);
      } else if (!currentEducation.description && 
                 line.length > 10 && 
                 !line.match(/^\d{4}/) &&
                 !educationKeywords.some(k => lowerLine.includes(k))) {
        currentEducation.description = (currentEducation.description || '') + ' ' + line;
      }

      // Check for GPA
      const gpaMatch = line.match(/GPA[:\s]+(\d\.\d{1,2})/i);
      if (gpaMatch) {
        currentEducation.gpa = parseFloat(gpaMatch[1]);
        console.log(`📊 Found GPA: ${currentEducation.gpa}`);
      }

      // Check for dates in subsequent lines
      const dateRegex = /\b(19|20)\d{2}\b/g;
      const dates = line.match(dateRegex);
      if (dates && dates.length >= 2 && !currentEducation.startDate) {
        currentEducation.startDate = new Date(parseInt(dates[0]), 0, 1);
        currentEducation.endDate = new Date(parseInt(dates[1]), 0, 1);
        console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
      }

      // If we hit a new section (not education), stop
      if (line.match(/^(Experience|Skills|Projects|Certifications|Languages|References|Summary|Objective|Profile|Work|Employment)/i)) {
        foundEducation = false;
        if (currentEducation && currentEducation.institution) {
          education.push(currentEducation);
          console.log(`✅ Added education: ${currentEducation.institution}`);
        }
        currentEducation = null;
        educationSectionStarted = false;
      }
    }
  }

  // Don't forget the last education
  if (currentEducation && currentEducation.institution) {
    education.push(currentEducation);
    console.log(`✅ Added education: ${currentEducation.institution}`);
  }

  // Clean up education entries
  const filteredEducation = education.filter(e => e.institution && e.institution.length > 2);
  console.log(`✅ Found ${filteredEducation.length} education entries`);
  return filteredEducation;
};

/**
 * Parse work experience from text
 */
const parseWorkExperience = (text) => {
  console.log('🔍 Parsing work experience...');
  
  const experiences = [];
  const experienceKeywords = [
    'experience', 'work', 'employment', 'job', 'position', 'role',
    'professional experience', 'work history', 'employment history',
    'career', 'occupation'
  ];
  
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  let currentExperience = null;
  let foundExperience = false;
  let experienceSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();

    // Check if this line contains experience keywords
    const isExperienceLine = experienceKeywords.some(keyword => lowerLine.includes(keyword));

    if (isExperienceLine && !foundExperience) {
      foundExperience = true;
      experienceSectionStarted = true;
      console.log('💼 Found work experience section');
      continue;
    }

    if (foundExperience) {
      // Check if we've hit a new section
      if (line.match(/^(Education|Skills|Projects|Certifications|Languages|References|Summary|Objective|Profile)/i)) {
        foundExperience = false;
        if (currentExperience && currentExperience.company) {
          experiences.push(currentExperience);
          console.log(`✅ Added experience: ${currentExperience.position} at ${currentExperience.company}`);
        }
        currentExperience = null;
        experienceSectionStarted = false;
        continue;
      }

      // Try to detect company name (often in caps or with certain patterns)
      const companyMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|LLC|Corp|Corporation|Company|Ltd|Limited))/);
      const positionMatch = line.match(/^(Senior|Junior|Lead|Principal|Staff|Associate|Developer|Engineer|Manager|Director|Consultant|Analyst|Architect|Designer|Product|Project|Program|Software|Full[-\s]Stack|Frontend|Backend|DevOps|QA|Test|Data|Machine Learning|AI|Cloud|Network|System|Security|DevSecOps)/i);

      if (!currentExperience) {
        // Start new experience
        currentExperience = {
          company: '',
          position: '',
          location: '',
          startDate: null,
          endDate: null,
          current: false,
          description: '',
          achievements: []
        };

        // Try to parse company and position from the same line
        if (companyMatch) {
          currentExperience.company = companyMatch[0];
          console.log(`🏢 Found company: ${currentExperience.company}`);
          const remaining = line.replace(companyMatch[0], '').trim();
          if (remaining.length > 0) {
            currentExperience.position = remaining;
            console.log(`💼 Found position: ${currentExperience.position}`);
          }
        } else if (positionMatch) {
          currentExperience.position = line;
          console.log(`💼 Found position: ${currentExperience.position}`);
        } else {
          // Try to guess if it's a company
          const words = line.split(' ');
          if (words.length >= 2 && words[0].length > 2 && words[0].charAt(0) === words[0].charAt(0).toUpperCase()) {
            currentExperience.company = line;
            console.log(`🏢 Found company: ${currentExperience.company}`);
          }
        }

        // Try to find dates in the line
        const dateRegex = /\b(19|20)\d{2}\b/g;
        const dates = line.match(dateRegex);
        if (dates && dates.length >= 2) {
          currentExperience.startDate = new Date(parseInt(dates[0]), 0, 1);
          currentExperience.endDate = new Date(parseInt(dates[1]), 0, 1);
          console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
        } else if (dates && dates.length === 1) {
          currentExperience.startDate = new Date(parseInt(dates[0]), 0, 1);
          console.log(`📅 Found start date: ${dates[0]}`);
        }

        if (lowerLine.includes('present') || lowerLine.includes('current')) {
          currentExperience.current = true;
          console.log('🔄 Currently working');
        }

      } else {
        // Add to description or achievements
        if (line.length > 10 && !line.match(/^\d{4}/)) {
          // Check if it's an achievement (starts with bullet or dash)
          if (line.match(/^[•\-*]\s/)) {
            const achievement = line.replace(/^[•\-*]\s/, '').trim();
            currentExperience.achievements.push(achievement);
            console.log(`⭐ Found achievement: ${achievement.substring(0, 50)}...`);
          } else {
            currentExperience.description = (currentExperience.description || '') + ' ' + line;
          }
        }

        // Check for dates in subsequent lines
        const dateRegex = /\b(19|20)\d{2}\b/g;
        const dates = line.match(dateRegex);
        if (dates && dates.length >= 2 && !currentExperience.startDate) {
          currentExperience.startDate = new Date(parseInt(dates[0]), 0, 1);
          currentExperience.endDate = new Date(parseInt(dates[1]), 0, 1);
          console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
        }

        if (lowerLine.includes('present') || lowerLine.includes('current')) {
          currentExperience.current = true;
        }
      }
    }
  }

  // Don't forget the last experience
  if (currentExperience && currentExperience.company) {
    experiences.push(currentExperience);
    console.log(`✅ Added experience: ${currentExperience.position} at ${currentExperience.company}`);
  }

  const filteredExperiences = experiences.filter(e => e.company && e.company.length > 2);
  console.log(`✅ Found ${filteredExperiences.length} work experience entries`);
  return filteredExperiences;
};

/**
 * Parse skills from text
 */
const parseSkills = (text) => {
  console.log('🔍 Parsing skills...');
  
  const skills = [];
  const skillKeywords = [
    'skills', 'technical skills', 'soft skills', 'competencies', 'expertise',
    'core competencies', 'skill set', 'proficiencies', 'technologies',
    'programming languages', 'tools', 'frameworks'
  ];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (skillKeywords.some(keyword => lowerSection.includes(keyword))) {
      // Split by common separators
      const skillItems = section.split(/[,;•\n|/]/)
        .map(s => s.trim())
        .filter(s => s.length > 1 && s.length < 60);
      
      for (const item of skillItems) {
        // Skip if it's a section header
        if (skillKeywords.some(keyword => item.toLowerCase().includes(keyword))) {
          continue;
        }
        
        // Clean up the skill name
        const cleanName = item.replace(/^(Technical|Soft|Language|Other)\s*:?\s*/i, '').trim();
        if (cleanName && cleanName.length > 1) {
          skills.push({
            name: cleanName,
            level: 'Intermediate',
            category: 'Technical'
          });
        }
      }
    }
  }
  
  // If no skills found, try to find skills in the text
  if (skills.length === 0) {
    console.log('🔍 Searching for skills in full text...');
    // Look for common skill patterns
    const commonSkills = [
      'JavaScript', 'Python', 'Java', 'C++', 'React', 'Node.js', 'Angular',
      'Vue.js', 'TypeScript', 'HTML', 'CSS', 'SQL', 'MongoDB', 'PostgreSQL',
      'MySQL', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Git',
      'Agile', 'Scrum', 'Project Management', 'Leadership', 'Communication',
      'Problem Solving', 'Data Analysis', 'Machine Learning', 'AI', 'TensorFlow',
      'PyTorch', 'Flask', 'Django', 'Spring Boot', 'Ruby on Rails', 'PHP',
      'Laravel', 'Swift', 'Kotlin', 'Flutter', 'React Native', 'GraphQL',
      'REST API', 'Microservices', 'CI/CD', 'Jenkins', 'Ansible', 'Terraform'
    ];
    
    for (const skill of commonSkills) {
      if (text.includes(skill) && !skills.some(s => s.name === skill)) {
        skills.push({
          name: skill,
          level: 'Intermediate',
          category: 'Technical'
        });
        console.log(`🔧 Found skill: ${skill}`);
      }
    }
  }
  
  console.log(`✅ Found ${skills.length} skills`);
  return skills;
};

/**
 * Parse certifications from text
 */
const parseCertifications = (text) => {
  console.log('🔍 Parsing certifications...');
  
  const certifications = [];
  const certKeywords = [
    'certification', 'certified', 'certificate', 'credential',
    'aws certified', 'google certified', 'microsoft certified',
    'scrum master', 'pmp', 'project management', 'itil'
  ];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (certKeywords.some(keyword => lowerSection.includes(keyword))) {
      const lines = section.split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        const certName = line.trim();
        if (certName.length > 5 && 
            !certKeywords.some(k => certName.toLowerCase().includes(k)) &&
            certName.length < 100) {
          certifications.push({
            name: certName,
            organization: '',
            issueDate: null,
            expiryDate: null,
            credentialId: '',
            credentialUrl: ''
          });
          console.log(`📜 Found certification: ${certName}`);
        }
      }
    }
  }
  
  console.log(`✅ Found ${certifications.length} certifications`);
  return certifications;
};

/**
 * Parse projects from text
 */
const parseProjects = (text) => {
  console.log('🔍 Parsing projects...');
  
  const projects = [];
  const projectKeywords = ['project', 'portfolio', 'github', 'repository', 'side project'];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (projectKeywords.some(keyword => lowerSection.includes(keyword))) {
      const lines = section.split('\n').filter(l => l.trim());
      
      if (lines.length >= 2) {
        const name = lines[0]?.trim() || '';
        const description = lines.slice(1).join(' ').trim();
        
        // Try to find technologies
        const techKeywords = [
          'React', 'Node.js', 'Python', 'Java', 'JavaScript', 'HTML', 'CSS',
          'Angular', 'Vue', 'TypeScript', 'Django', 'Flask', 'Spring Boot',
          'Ruby on Rails', 'PHP', 'Laravel', 'SQL', 'MongoDB', 'Firebase',
          'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'GraphQL', 'REST API'
        ];
        const technologies = techKeywords.filter(tech => description.includes(tech));
        
        if (name && name.length > 2) {
          projects.push({
            name: name,
            description: description,
            technologies: technologies,
            startDate: null,
            endDate: null,
            url: '',
            githubUrl: ''
          });
          console.log(`📁 Found project: ${name}`);
        }
      }
    }
  }
  
  console.log(`✅ Found ${projects.length} projects`);
  return projects;
};

/**
 * Parse languages from text
 */
const parseLanguages = (text) => {
  console.log('🔍 Parsing languages...');
  
  const languages = [];
  const languageKeywords = ['languages', 'language proficiency', 'bilingual', 'multilingual'];
  
  // Common languages
  const commonLanguages = [
    'English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese',
    'Arabic', 'Portuguese', 'Russian', 'Italian', 'Dutch', 'Korean',
    'Turkish', 'Hindi', 'Urdu', 'Bengali', 'Punjabi', 'Tamil',
    'Vietnamese', 'Thai', 'Polish', 'Greek', 'Hebrew', 'Swedish',
    'Norwegian', 'Danish', 'Finnish', 'Indonesian', 'Malay'
  ];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (languageKeywords.some(keyword => lowerSection.includes(keyword))) {
      for (const lang of commonLanguages) {
        if (section.includes(lang)) {
          // Try to determine proficiency
          let proficiency = 'Intermediate';
          if (section.match(new RegExp(`${lang}.*(Native|Fluent|Bilingual)`, 'i'))) {
            proficiency = 'Fluent';
          } else if (section.match(new RegExp(`${lang}.*(Advanced|Professional|Proficient)`, 'i'))) {
            proficiency = 'Intermediate';
          } else if (section.match(new RegExp(`${lang}.*(Basic|Beginner|Elementary)`, 'i'))) {
            proficiency = 'Basic';
          }
          
          languages.push({
            name: lang,
            proficiency: proficiency
          });
          console.log(`🗣️ Found language: ${lang} (${proficiency})`);
        }
      }
    }
  }
  
  // If no languages found, try to find from common languages
  if (languages.length === 0) {
    console.log('🔍 Searching for languages in full text...');
    for (const lang of commonLanguages) {
      if (text.includes(lang)) {
        languages.push({
          name: lang,
          proficiency: 'Intermediate'
        });
        console.log(`🗣️ Found language: ${lang}`);
      }
    }
  }
  
  console.log(`✅ Found ${languages.length} languages`);
  return languages;
};

/**
 * Main parse function for resume
 */
const parseResumePDF = async (filePath) => {
  try {
    console.log('📄 Starting resume parsing for:', filePath);
    
    const ext = path.extname(filePath).toLowerCase();
    let text = '';
    
    if (ext === '.pdf') {
      console.log('📄 Parsing PDF file...');
      text = await extractTextFromPDF(filePath);
    } else if (ext === '.docx' || ext === '.doc') {
      console.log('📄 Parsing Word document...');
      text = await extractTextFromWord(filePath);
    } else {
      throw new Error('Unsupported file format. Please upload PDF or Word document.');
    }
    
    if (!text || text.trim().length < 50) {
      throw new Error('Could not extract text from the document. Please ensure it contains readable text.');
    }
    
    console.log('📝 Extracted text length:', text.length);
    console.log('📝 Text preview:', text.substring(0, 500));
    
    // Parse different sections
    console.log('🔍 Parsing personal info...');
    const personalInfo = parsePersonalInfo(text);
    console.log('✅ Personal info parsed:', personalInfo);
    
    console.log('🔍 Parsing education...');
    const education = parseEducation(text);
    console.log('✅ Education parsed:', education.length, 'entries');
    
    console.log('🔍 Parsing work experience...');
    const workExperience = parseWorkExperience(text);
    console.log('✅ Work experience parsed:', workExperience.length, 'entries');
    
    console.log('🔍 Parsing skills...');
    const skills = parseSkills(text);
    console.log('✅ Skills parsed:', skills.length, 'entries');
    
    console.log('🔍 Parsing certifications...');
    const certifications = parseCertifications(text);
    console.log('✅ Certifications parsed:', certifications.length, 'entries');
    
    console.log('🔍 Parsing projects...');
    const projects = parseProjects(text);
    console.log('✅ Projects parsed:', projects.length, 'entries');
    
    console.log('🔍 Parsing languages...');
    const languages = parseLanguages(text);
    console.log('✅ Languages parsed:', languages.length, 'entries');
    
    // Create professional summary from first few lines
    const lines = text.split('\n').filter(l => l.trim());
    let summary = '';
    
    // Try to find a summary section
    let summaryFound = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (line.includes('summary') || line.includes('objective') || line.includes('profile')) {
        summaryFound = true;
        // Collect the next 5-10 lines as summary
        const summaryLines = [];
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].match(/^(Education|Experience|Skills|Projects|Certifications|Languages|References)/i)) {
            break;
          }
          summaryLines.push(lines[j]);
        }
        summary = summaryLines.join(' ').trim();
        console.log('📝 Found professional summary');
        break;
      }
    }
    
    if (!summary && lines.length > 3) {
      summary = lines.slice(0, 5).join(' ').trim();
      console.log('📝 Using first 5 lines as summary');
    }
    
    // Build the result
    const result = {
      personalInfo,
      professionalSummary: {
        title: personalInfo.firstName ? `${personalInfo.firstName} ${personalInfo.lastName || ''}`.trim() : 'Professional',
        summary: summary || 'Experienced professional with a strong background in the industry.',
        experienceLevel: 'Mid Level'
      },
      education,
      skills,
      workExperience,
      certifications,
      projects,
      languages,
      rawText: text.substring(0, 2000) // Store first 2000 chars for reference
    };
    
    console.log('✅ Resume parsing completed successfully');
    console.log('📊 Summary of parsed data:');
    console.log(`   👤 Personal Info: ${personalInfo.firstName} ${personalInfo.lastName}`);
    console.log(`   🎓 Education: ${education.length} entries`);
    console.log(`   💼 Work Experience: ${workExperience.length} entries`);
    console.log(`   🔧 Skills: ${skills.length} entries`);
    console.log(`   📜 Certifications: ${certifications.length} entries`);
    console.log(`   📁 Projects: ${projects.length} entries`);
    console.log(`   🗣️ Languages: ${languages.length} entries`);
    
    return result;
  } catch (error) {
    console.error('❌ Error parsing resume:', error);
    throw new Error(`Failed to parse resume: ${error.message}`);
  }
};

module.exports = { parseResumePDF };