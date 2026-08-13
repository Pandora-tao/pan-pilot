import { gsap } from "gsap";

/**
 * 在允许动效的环境（prefers-reduced-motion: no-preference）里执行 GSAP 动画；
 * 用户要求减少动态效果时跳过动画，界面直接呈现最终静态布局。
 * 返回清理函数，组件卸载时调用以回收 matchMedia 与其中的 tween。
 */
export function withMotion(build: () => void): () => void {
  const media = gsap.matchMedia();
  media.add("(prefers-reduced-motion: no-preference)", build);
  return () => media.revert();
}
