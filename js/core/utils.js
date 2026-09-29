/* MATH UTILITIES */
export const Mat3 = {
  identity: () => [1,0,0, 0,1,0, 0,0,1],
  multiply: (a, b) => [
    a[0]*b[0] + a[1]*b[3] + a[2]*b[6], a[0]*b[1] + a[1]*b[4] + a[2]*b[7], a[0]*b[2] + a[1]*b[5] + a[2]*b[8],
    a[3]*b[0] + a[4]*b[3] + a[5]*b[6], a[3]*b[1] + a[4]*b[4] + a[5]*b[7], a[3]*b[2] + a[4]*b[5] + a[5]*b[8],
    a[6]*b[0] + a[7]*b[3] + a[8]*b[6], a[6]*b[1] + a[7]*b[4] + a[8]*b[7], a[6]*b[2] + a[7]*b[5] + a[8]*b[8]
  ],
  fromAxisAngle: (axis, angle) => {
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const x = axis[0]/len, y = axis[1]/len, z = axis[2]/len;
    const s = Math.sin(angle), c = Math.cos(angle), t = 1-c;
    return [t*x*x+c, t*x*y-s*z, t*x*z+s*y, t*x*y+s*z, t*y*y+c, t*y*z-s*x, t*x*z-s*y, t*y*z+s*x, t*z*z+c];
  },
  transformPoint: (m, p) => [m[0]*p[0]+m[1]*p[1]+m[2]*p[2], m[3]*p[0]+m[4]*p[1]+m[5]*p[2], m[6]*p[0]+m[7]*p[1]+m[8]*p[2]]
};

export const lerp = (a, b, t) => a + (b - a) * t;

export const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));