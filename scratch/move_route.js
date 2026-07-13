const fs = require('fs');
const path = require('path');

const filepath = path.join(__dirname, '../routes/resume.routes.js');
let content = fs.readFileSync(filepath, 'utf8');

// Identify the block to move:
const startKeyword = '// ========== UPLOAD RESUME TO CLOUDINARY ==========';
const endKeyword = '// ========== GET RECOMMENDATIONS ==========';

const startIndex = content.indexOf(startKeyword);
const endIndex = content.indexOf(endKeyword);

if (startIndex === -1 || endIndex === -1) {
  console.error('Could not find keywords!', { startIndex, endIndex });
  process.exit(1);
}

// Slice out the upload route block
let uploadBlock = content.substring(startIndex, endIndex);

// Remove it from the original place
content = content.replace(uploadBlock, '');

// Now we need to insert it right before GET SINGLE RESUME
const targetKeyword = '// ========== GET SINGLE RESUME ==========';
const targetIndex = content.indexOf(targetKeyword);

if (targetIndex === -1) {
  console.error('Could not find target keyword!', { targetIndex });
  process.exit(1);
}

// Fix the warnings override in the uploadBlock
// We want to replace:
//     if (parseError) {
//       responseData.warning = `Parsing completed with some issues: ${parseError}`;
//     }
//     if (confidenceScore < 50) {
//       responseData.warning = 'Resume parsing had low confidence. Please review and update the extracted information.';
//     }
// with the concatenated version.

const oldWarningCode = `    // Add parsing warnings if any
    if (parseError) {
      responseData.warning = \`Parsing completed with some issues: \${parseError}\`;
    }
    if (confidenceScore < 50) {
      responseData.warning = 'Resume parsing had low confidence. Please review and update the extracted information.';
    }`;

const newWarningCode = `    // Add parsing warnings if any
    const warnings = [];
    if (parseError) {
      warnings.push(\`Parsing completed with some issues: \${parseError}\`);
    }
    if (confidenceScore < 50) {
      warnings.push('Resume parsing had low confidence. Please review and update the extracted information.');
    }
    if (warnings.length > 0) {
      responseData.warning = warnings.join(' | ');
    }`;

if (!uploadBlock.includes(oldWarningCode)) {
  console.error('Warning code snippet not found exactly in the block!');
  process.exit(1);
}

uploadBlock = uploadBlock.replace(oldWarningCode, newWarningCode);

// Let's also adjust the count check inside the uploadBlock from 2 to 10.
const oldCountCheck = `      const count = await Resume.countDocuments({ user: req.user._id });
      if (count >= 2) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 2 resumes allowed per user'
        });
      }`;

const newCountCheck = `      const count = await Resume.countDocuments({ user: req.user._id });
      if (count >= 10) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 10 resumes allowed per user'
        });
      }`;

if (!uploadBlock.includes(oldCountCheck)) {
  console.error('Count check code snippet not found exactly in the block!');
  process.exit(1);
}

uploadBlock = uploadBlock.replace(oldCountCheck, newCountCheck);

// Insert the modified upload block
const beforeInsert = content.substring(0, targetIndex);
const afterInsert = content.substring(targetIndex);

const newContent = beforeInsert + uploadBlock + afterInsert;

fs.writeFileSync(filepath, newContent, 'utf8');
console.log('Successfully moved and updated upload route!');
