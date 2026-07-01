export type ReanswerRequestBody = {
    questionText: string;
    language: 'zh' | 'en';
    subject: string;
    subjectId?: string;
    imageBase64?: string;
    gradeSemester?: string;
};

export function buildReanswerRequestBody({
    questionText,
    language,
    subject,
    subjectId,
    imagePreview,
    gradeSemester,
}: {
    questionText: string;
    language: 'zh' | 'en';
    subject: string;
    subjectId?: string;
    imagePreview?: string | null;
    gradeSemester?: string;
}): ReanswerRequestBody {
    const requestBody: ReanswerRequestBody = {
        questionText,
        language,
        subject,
    };

    if (subjectId) {
        requestBody.subjectId = subjectId;
    }

    if (imagePreview) {
        requestBody.imageBase64 = imagePreview;
    }

    if (gradeSemester) {
        requestBody.gradeSemester = gradeSemester;
    }

    return requestBody;
}
