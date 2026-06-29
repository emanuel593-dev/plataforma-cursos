import React, { useEffect, useRef } from 'react';

interface Props {
  audioLevel: number;
  isRecording: boolean;
}

export const WaveformVisualizer = ({ audioLevel, isRecording }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const dataArray = useRef(new Float32Array(128).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const targetLevel = isRecording ? audioLevel : 0;

      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00ff00';
      ctx.lineCap = 'round';

      const sliceWidth = width / dataArray.current.length;
      let x = 0;

      for (let i = 0; i < dataArray.current.length; i++) {
        const noise = (Math.random() - 0.5) * targetLevel * 0.5;
        const target = (targetLevel + noise) * height * 0.8;
        dataArray.current[i] += (target - dataArray.current[i]) * 0.2;
        const v = dataArray.current[i];
        const y = height / 2 + (i % 2 === 0 ? v : -v) / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceWidth;
      }

      ctx.stroke();
      animationRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationRef.current);
  }, [audioLevel, isRecording]);

  return (
    <div className="w-full h-12 bg-black/20 rounded-lg border border-white/5 overflow-hidden relative">
      <canvas ref={canvasRef} width="400" height="48" className="w-full h-full opacity-80" />
      {!isRecording && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-[8px] font-mono text-hw-muted uppercase tracking-widest opacity-40">Signal Standby</div>
        </div>
      )}
    </div>
  );
};
