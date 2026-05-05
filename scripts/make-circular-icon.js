#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *	Copyright (c) Microsoft Corporation. All rights reserved.
 *	Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Create a circular version of an icon by applying a circular mask

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2];
const outputPath = process.argv[3] || '/tmp/vibeide-circular.png';

if (!sourcePath) {
	console.error('Usage: node make-circular-icon.js <input.png> [output.png]');
	process.exit(1);
}

if (!fs.existsSync(sourcePath)) {
	console.error(`Error: Source file not found: ${sourcePath}`);
	process.exit(1);
}

async function createCircularIcon() {
	try {
		// Get source image dimensions
		const metadata = await sharp(sourcePath).metadata();
		const size = Math.max(metadata.width, metadata.height);
		const radius = size / 2;

		// Create circular SVG mask
		const svgMask = `
			<svg width="${size}" height="${size}">
				<circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/>
			</svg>
		`;

		// Apply circular mask to the image
		await sharp(sourcePath)
			.resize(size, size, {
				fit: 'contain',
				background: { r: 0, g: 0, b: 0, alpha: 0 }
			})
			.composite([
				{
					input: Buffer.from(svgMask),
					blend: 'dest-in'
				}
			])
			.png()
			.toFile(outputPath);

		console.log(`Circular icon created: ${outputPath}`);
	} catch (error) {
		console.error(`Error creating circular icon: ${error.message}`);
		process.exit(1);
	}
}

createCircularIcon();

