A dynamic CAPTCHA implemented using time frames and SVG.使用svg和帧的动态验证码




 * SVG 九宫格测试页面识别脚本（仅分析，不点击、不提交）
 * 原理：DOM 枚举帧图层 → 浏览器原生渲染 → 前景归一化 → 多特征匹配 → 置信度判定
 * 使用方法：在本地或自有测试页面的控制台中粘贴全部代码执行。
   js能在控制台测试能够成功，可以转换为其他
   仅用于交流。



example:

![alt text](image-2.png)
![alt text](image-3.png)
![alt text](image-4.png)

 output结果;
 ![alt text](image.png)
