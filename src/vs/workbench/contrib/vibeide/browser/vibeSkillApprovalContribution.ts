/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Скиллы — проверить и одобрить»: скиллы, которые агент видит только с вашего одобрения.
 *
 * The pick is the approval state itself: a ticked skill is approved. Ticking approves its files as
 * they are now; unticking withdraws the approval. Skills bundled with the product or shipped with
 * the release unchanged are not listed — there is nothing of theirs to approve.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import { describeSkillForApproval, describeSkillTrust, SKILLS_REVIEW_COMMAND_ID, VibeSkillPackage } from '../common/skillApproval.js';
import { skillOriginLabel } from '../common/vibeSkillProvenance.js';
import { IVibeSkillsLibraryService, VibeSkillEntry } from '../common/vibeSkillsLibraryService.js';

interface ReviewedSkill extends VibeSkillEntry {
	readonly package: VibeSkillPackage;
}

interface SkillReviewItem extends IQuickPickItem {
	readonly skill: ReviewedSkill;
}

registerAction2(class VibeReviewSkillsAction extends Action2 {
	constructor() {
		super({
			id: SKILLS_REVIEW_COMMAND_ID,
			title: localize2('vibeide.skills.review', 'Скиллы — проверить и одобрить'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const library = accessor.get(IVibeSkillsLibraryService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		const skills = (await library.getSkills()).filter((skill): skill is ReviewedSkill =>
			skill.package !== undefined && skill.package.trust !== 'builtin' && skill.package.trust !== 'shipped');
		if (skills.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.skills.review.none', "Одобрять нечего: все скиллы встроены или пришли с релизом без изменений."),
			});
			return;
		}

		const items: SkillReviewItem[] = skills.map(skill => ({
			skill,
			label: skill.skillId,
			description: `${describeSkillTrust(skill.package.trust)} · ${skillOriginLabel(skill.package.origin)}`,
			// The first line of the approval text repeats the label and the description above.
			detail: describeSkillForApproval(skill.skillId, skill.package).split('\n').slice(1).join(' · '),
			picked: skill.package.trust === 'approved',
			// No fingerprint, nothing to bind an approval to: shown, but cannot be ticked.
			disabled: skill.package.trust === 'unverifiable',
		}));
		const picked = await quickInput.pick(items, {
			canPickMany: true,
			placeHolder: localize('vibeide.skills.review.placeholder', "Отмеченные скиллы агент видит. Отметьте, чтобы одобрить файлы скилла как они есть сейчас; снимите отметку, чтобы отозвать одобрение."),
		});
		if (!picked) {
			return;
		}

		const chosen = new Set(picked.map(item => item.skill));
		const approve = skills.filter(skill => chosen.has(skill) && skill.package.trust !== 'approved');
		const revoke = skills.filter(skill => !chosen.has(skill) && skill.package.trust === 'approved');
		await library.approveSkills(approve);
		await library.revokeSkillApproval(revoke);
		if (approve.length > 0 || revoke.length > 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.skills.review.done', "Одобрено скиллов: {0}. Отозвано: {1}.", approve.length, revoke.length),
			});
		}
	}
});
