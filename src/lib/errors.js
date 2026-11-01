'use strict';
// ข้อผิดพลาดที่ตั้งใจส่งกลับไปให้ผู้ใช้ (มีรหัส + ข้อความภาษาไทย)

class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

const E = {
  validation: (message, details) => new AppError('VALIDATION_ERROR', message, 400, details),
  invalidPhone: () => new AppError('INVALID_PHONE', 'เบอร์โทรศัพท์ไม่ถูกต้อง ต้องเป็นเบอร์มือถือ 10 หลัก ขึ้นต้นด้วย 06, 08 หรือ 09', 400),
  unauthorized: (message = 'กรุณาเข้าสู่ระบบ') => new AppError('UNAUTHORIZED', message, 401),
  forbidden: (message = 'ไม่มีสิทธิ์ใช้งานส่วนนี้') => new AppError('FORBIDDEN', message, 403),
  csrf: () => new AppError('CSRF_INVALID', 'เซสชันหมดอายุหรือคำขอไม่ถูกต้อง กรุณารีเฟรชหน้าเว็บแล้วลองใหม่', 403),
  notFound: (message = 'ไม่พบข้อมูลที่ต้องการ') => new AppError('NOT_FOUND', message, 404),
  conflict: (code, message, details) => new AppError(code, message, 409, details),
  insufficientBalance: (need, have) =>
    new AppError('INSUFFICIENT_BALANCE', 'ยอดเงินในกระเป๋าไม่พอ กรุณาเติมเงินเข้าระบบก่อน', 402, { need, have }),
  rateLimited: (retryAfterSec) =>
    new AppError('RATE_LIMITED', `ทำรายการถี่เกินไป กรุณารอ ${retryAfterSec} วินาทีแล้วลองใหม่`, 429, { retryAfterSec }),
  maintenance: (message) => new AppError('MAINTENANCE', message || 'ระบบปิดปรับปรุงชั่วคราว กรุณาลองใหม่ภายหลัง', 503),
  providerUnavailable: (message) =>
    new AppError('PROVIDER_UNAVAILABLE', message || 'ระบบผู้ให้บริการขัดข้องชั่วคราว ยังไม่ได้ตัดเงิน กรุณาลองใหม่ในอีกสักครู่', 503),
};

module.exports = { AppError, E };
